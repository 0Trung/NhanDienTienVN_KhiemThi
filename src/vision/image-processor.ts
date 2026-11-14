/**
 * P03 · F3, F5, F6 — Bộ tiền xử lý: khung hình camera (ImageBitmap) → PreprocessResult, chạy được TRONG Web Worker.
 * Hai tầng resize dùng chung computeLetterbox:
 *  (a) tầng Canvas: OffscreenCanvas (thiếu thì canvas DOM) — dùng khi chạy thật;
 *  (b) tầng thuần: resize bilinear trên mảng RGBA — dùng cho test trong Node.
 * Không gọi ONNX, không NMS, không đo thời gian (worker tự đo).
 */
import { AppError } from '../contracts';
import type { IPreprocessor, LetterboxMeta, PreprocessResult, PreprocessorOptions } from '../contracts';
import { createLogger } from '../utils/logger';
import { computeLetterbox } from './letterbox';
import { buildAxisTable, rgbaToTensor, toGray } from './tensor';
import type { ByteArray, RgbaImage } from './tensor';

const log = createLogger('vision/preprocess');
const BYTES_PER_PIXEL = 4;
const BYTE_MAX = 255;

/**
 * Phần ngữ cảnh canvas 2D mà bộ tiền xử lý cần (port nhỏ để giả lập được trong Node).
 * OffscreenCanvasRenderingContext2D và CanvasRenderingContext2D đều thoả cấu trúc này.
 */
export interface Context2DLike {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: 'low' | 'medium' | 'high';
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: ImageBitmap,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number,
  ): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { readonly data: ByteArray; readonly width: number; readonly height: number };
}
/** Tạo ngữ cảnh canvas vuông size × size. Được tiêm qua tham số để test trong Node. */
export type Context2DFactory = (size: number) => Context2DLike;

/** Làm mịn 'low' = bilinear, gần nhất với cv2.INTER_LINEAR của bản mẫu P01. */
const SMOOTHING_QUALITY = 'low';

/**
 * Ngữ cảnh canvas thật: OffscreenCanvas (Web Worker), thiếu thì canvas DOM; bật willReadFrequently để getImageData nhanh.
 * @throws AppError UNSUPPORTED_BROWSER (fatal) khi môi trường không có canvas 2D.
 */
export function createDefaultContext2D(size: number): Context2DLike {
  const settings: CanvasRenderingContext2DSettings = { willReadFrequently: true, alpha: false };
  let ctx: Context2DLike | null = null;
  let kind: string | null = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    kind = 'OffscreenCanvas';
    ctx = new OffscreenCanvas(size, size).getContext('2d', settings);
  } else if (typeof document !== 'undefined') {
    kind = 'canvas DOM';
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    ctx = canvas.getContext('2d', settings);
  }
  if (ctx === null) {
    const reason = kind === null ? 'môi trường không có OffscreenCanvas lẫn canvas DOM' : `${kind} không trả về ngữ cảnh 2D`;
    throw new AppError('UNSUPPORTED_BROWSER', `Không tạo được canvas 2D để tiền xử lý ảnh: ${reason}`, true);
  }
  log.debug(`Đã tạo canvas tiền xử lý ${size}×${size} bằng ${kind}`);
  return ctx;
}

/**
 * Tầng thuần (b) — resize bilinear RGBA, tâm điểm ảnh lệch nửa ô như cv2.INTER_LINEAR, lặp điểm mép.
 * Uint8ClampedArray tự làm tròn và chặn 0..255. `out` được dùng lại nếu đúng độ dài, nếu không thì cấp phát mới.
 */
export function resizeBilinearRgba(src: RgbaImage, dstW: number, dstH: number, out?: Uint8ClampedArray): Uint8ClampedArray {
  const { data, width: srcW, height: srcH } = src;
  const sizesOk = [srcW, srcH, dstW, dstH].every((n) => Number.isInteger(n) && n > 0);
  if (!sizesOk || data.length < srcW * srcH * BYTES_PER_PIXEL) {
    throw new AppError('INFERENCE_FAILED', `Resize không hợp lệ: ${srcW}×${srcH} → ${dstW}×${dstH}`, false, { srcW, srcH, dstW, dstH });
  }
  const dst = out !== undefined && out.length === dstW * dstH * BYTES_PER_PIXEL ? out : new Uint8ClampedArray(dstW * dstH * BYTES_PER_PIXEL);
  const cols = buildAxisTable(srcW, dstW);
  const rows = buildAxisTable(srcH, dstH);
  const stride = srcW * BYTES_PER_PIXEL;
  let o = 0;
  for (let y = 0; y < dstH; y++) {
    const top = rows.i0[y]! * stride;
    const bottom = rows.i1[y]! * stride;
    const wy = rows.w[y]!;
    for (let x = 0; x < dstW; x++) {
      const a = cols.i0[x]! * BYTES_PER_PIXEL;
      const b = cols.i1[x]! * BYTES_PER_PIXEL;
      const wx = cols.w[x]!;
      for (let c = 0; c < BYTES_PER_PIXEL; c++) {
        const t0 = data[top + a + c]!;
        const b0 = data[bottom + a + c]!;
        const upper = t0 + (data[top + b + c]! - t0) * wx;
        const lower = b0 + (data[bottom + b + c]! - b0) * wx;
        dst[o++] = upper + (lower - upper) * wy;
      }
    }
  }
  return dst;
}

/**
 * Tầng thuần (b) đầy đủ: ảnh RGBA gốc → PreprocessResult, không canvas, không tái sử dụng buffer.
 * Cùng computeLetterbox/rgbaToTensor/toGray với tầng Canvas; gray lấy từ vùng ảnh đã resize (không có lề).
 */
export function preprocessRgba(src: RgbaImage, o: PreprocessorOptions): PreprocessResult {
  const meta = computeLetterbox(src.width, src.height, o.inputSize);
  const same = meta.newWidth === src.width && meta.newHeight === src.height;
  const region: RgbaImage = same
    ? src
    : { data: resizeBilinearRgba(src, meta.newWidth, meta.newHeight), width: meta.newWidth, height: meta.newHeight };
  return { tensor: rgbaToTensor(region.data, meta, undefined, o.padValue), letterbox: meta, gray: toGray(region, o.grayThumbWidth) };
}

/** Tầng Canvas (a): tô nền, vẽ bitmap vào (padX, padY, newW, newH), đọc lại CHỈ vùng ảnh (không đọc lề). */
function drawRegion(ctx: Context2DLike, bitmap: ImageBitmap, meta: LetterboxMeta, background: string): RgbaImage {
  try {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = SMOOTHING_QUALITY;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, meta.inputSize, meta.inputSize);
    ctx.drawImage(bitmap, 0, 0, meta.srcWidth, meta.srcHeight, meta.padX, meta.padY, meta.newWidth, meta.newHeight);
    const image = ctx.getImageData(meta.padX, meta.padY, meta.newWidth, meta.newHeight);
    if (image.width !== meta.newWidth || image.height !== meta.newHeight || image.data.length < image.width * image.height * BYTES_PER_PIXEL) {
      throw new AppError('INFERENCE_FAILED', 'Canvas trả về vùng ảnh sai kích thước', false, {
        expected: [meta.newWidth, meta.newHeight],
        actual: [image.width, image.height],
      });
    }
    return image;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('INFERENCE_FAILED', 'Không đọc được điểm ảnh từ bitmap (có thể đã bị đóng)', false, e);
  }
}

/**
 * F5 — Bộ tiền xử lý với canvas được tiêm (createPreprocessor dùng canvas thật). Canvas và buffer được tạo một lần
 * rồi dùng lại giữa các khung; buffer bị detach hoặc đổi kích thước thì tự cấp phát lại.
 * LƯU Ý: tensor và gray.data của kết quả là buffer TÁI SỬ DỤNG, chỉ hợp lệ đến lần process kế tiếp.
 * process() KHÔNG close bitmap (bên nhận CapturedFrame chịu trách nhiệm); lỗi mỗi khung là AppError không fatal:
 * INFERENCE_FAILED khi bitmap đã đóng/kích thước 0 hoặc canvas lỗi, UNSUPPORTED_BROWSER (fatal) khi không có canvas.
 * @throws AppError INFERENCE_FAILED (fatal) khi tuỳ chọn không hợp lệ.
 */
export function createPreprocessorWith(o: PreprocessorOptions, createContext: Context2DFactory): IPreprocessor {
  const { inputSize, padValue, grayThumbWidth } = o;
  const optionsOk =
    Number.isInteger(inputSize) && inputSize > 0 && padValue >= 0 && padValue <= BYTE_MAX && Number.isInteger(grayThumbWidth) && grayThumbWidth > 0;
  if (!optionsOk) throw new AppError('INFERENCE_FAILED', 'Tuỳ chọn tiền xử lý không hợp lệ', true, o);

  const background = `rgb(${padValue},${padValue},${padValue})`;
  let ctx: Context2DLike | null = null;
  let tensorBuf: Float32Array | undefined;
  let grayBuf: Uint8Array | undefined;

  return {
    process(bitmap: ImageBitmap): PreprocessResult {
      // F6: bitmap đã close() có width = height = 0; kiểm tra TRƯỚC khi đụng canvas hay buffer.
      const width = bitmap?.width ?? 0;
      const height = bitmap?.height ?? 0;
      if (!(width > 0 && height > 0)) {
        throw new AppError('INFERENCE_FAILED', 'Bitmap đã đóng hoặc có kích thước 0, không thể tiền xử lý', false, { width, height });
      }
      const letterbox = computeLetterbox(width, height, inputSize);
      ctx ??= createContext(inputSize);
      const region = drawRegion(ctx, bitmap, letterbox, background);
      tensorBuf = rgbaToTensor(region.data, letterbox, tensorBuf, padValue);
      const gray = toGray(region, grayThumbWidth, grayBuf);
      grayBuf = gray.data;
      return { tensor: tensorBuf, letterbox, gray };
    },
  };
}

/** Bảng đăng ký xuất khẩu: createPreprocessor(o: PreprocessorOptions): IPreprocessor, dùng canvas thật. */
export function createPreprocessor(o: PreprocessorOptions): IPreprocessor {
  return createPreprocessorWith(o, createDefaultContext2D);
}