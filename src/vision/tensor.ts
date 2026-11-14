/**
 * P03 · F2 + phần thuần của F4 — Chuyển mảng RGBA thành tensor YOLO (NCHW float32) và ảnh xám nhỏ.
 * Chỉ nhận mảng byte: không đụng DOM, chạy được trong Node và Web Worker.
 */
import { AppError } from '../contracts';
import type { GrayImage, LetterboxMeta } from '../contracts';

/** Mảng byte điểm ảnh: Uint8Array hoặc Uint8ClampedArray (ImageData.data). */
export type ByteArray = Uint8Array | Uint8ClampedArray;
/** Ảnh RGBA 8 bit: 4 byte mỗi điểm (R, G, B, A), các hàng nối tiếp nhau, không đệm. */
export interface RgbaImage { data: ByteArray; width: number; height: number }

/** Giá trị nền lề mặc định (model-config.json: padValue = 114). */
export const DEFAULT_PAD_VALUE = 114;
const CHANNELS = 3;
const BYTES_PER_PIXEL = 4;
const BYTE_MAX = 255;
/** Hệ số độ sáng 0,299R + 0,587G + 0,114B nhân 1000 để cộng bằng số nguyên (làm tròn không sai số nhị phân). */
const LUMA_R = 299;
const LUMA_G = 587;
const LUMA_B = 114;
const LUMA_SCALE = 1000;

/**
 * Bảng v/255 dạng float32, tính một lần. Giá trị bằng đúng kết quả phép chia float32 của numpy ở bản mẫu P01
 * (v/255 có chu kỳ nhị phân 8 bit nên làm tròn kép double→float32 không bao giờ lệch).
 */
const UNIT_LUT = new Float32Array(BYTE_MAX + 1).map((_, v) => v / BYTE_MAX);

function fail(message: string, detail?: unknown): never {
  throw new AppError('INFERENCE_FAILED', message, false, detail);
}

function isSize(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

/**
 * Bảng nội suy một trục, tâm điểm ảnh lệch nửa ô như cv2.INTER_LINEAR: với mỗi toạ độ đích d có hai chỉ số nguồn
 * kề nhau (i0, i1) và trọng số w của i1. Ngoài mép thì lặp điểm mép (w = 0).
 */
export interface AxisTable { i0: Int32Array; i1: Int32Array; w: Float64Array }

/** Dựng bảng nội suy cho trục có srcN điểm nguồn và dstN điểm đích (cả hai là số nguyên dương). */
export function buildAxisTable(srcN: number, dstN: number): AxisTable {
  const i0 = new Int32Array(dstN);
  const i1 = new Int32Array(dstN);
  const w = new Float64Array(dstN);
  const ratio = srcN / dstN;
  const last = srcN - 1;
  for (let d = 0; d < dstN; d++) {
    const f = (d + 0.5) * ratio - 0.5;
    const base = Math.floor(f);
    if (base < 0) {
      // trước tâm điểm đầu: i0 = i1 = 0, w = 0
    } else if (base >= last) {
      i0[d] = last;
      i1[d] = last;
    } else {
      i0[d] = base;
      i1[d] = base + 1;
      w[d] = f - base;
    }
  }
  return { i0, i1, w };
}

/**
 * F2 — Vùng ảnh đã resize (newWidth × newHeight RGBA) → tensor NCHW [1,3,S,S], kênh RGB, chia 255, một lượt duyệt.
 * Lề ngoài vùng ảnh = padValue/255; vùng ảnh dán tại (padX, padY). Mọi phần tử của tensor đều được ghi đúng một lần,
 * nên dùng lại `out` giữa các khung không để sót dữ liệu cũ.
 * `out` chỉ được dùng nếu đúng độ dài 3·S·S, nếu không (hoặc đã bị detach do transfer) thì cấp phát mảng mới: luôn dùng giá trị trả về.
 * @throws AppError INFERENCE_FAILED khi meta không hợp lệ, vùng ảnh thiếu byte hoặc padValue ngoài 0..255.
 */
export function rgbaToTensor(
  region: ByteArray,
  meta: LetterboxMeta,
  out?: Float32Array,
  padValue: number = DEFAULT_PAD_VALUE,
): Float32Array {
  const { inputSize: size, newWidth: w, newHeight: h, padX, padY } = meta;
  const metaOk =
    isSize(size) && isSize(w) && isSize(h) && Number.isInteger(padX) && Number.isInteger(padY) &&
    padX >= 0 && padY >= 0 && padX + w <= size && padY + h <= size;
  if (!metaOk) fail('Siêu dữ liệu letterbox không hợp lệ', meta);
  if (region.length < w * h * BYTES_PER_PIXEL) fail(`Vùng ảnh có ${region.length} byte, cần ${w * h * BYTES_PER_PIXEL}`, meta);
  if (!(padValue >= 0 && padValue <= BYTE_MAX)) fail(`padValue phải trong 0..255, nhận được ${String(padValue)}`);

  const plane = size * size;
  const tensor = out !== undefined && out.length === CHANNELS * plane ? out : new Float32Array(CHANNELS * plane);
  const pad = padValue / BYTE_MAX;
  const greenAt = plane;
  const blueAt = 2 * plane;
  const fillSpan = (from: number, to: number): void => {
    tensor.fill(pad, from, to);
    tensor.fill(pad, greenAt + from, greenAt + to);
    tensor.fill(pad, blueAt + from, blueAt + to);
  };

  for (let y = 0; y < size; y++) {
    const row = y * size;
    if (y < padY || y >= padY + h) {
      fillSpan(row, row + size); // hàng lề trên/dưới
      continue;
    }
    const left = row + padX;
    const right = left + w;
    fillSpan(row, left);
    fillSpan(right, row + size);
    let p = (y - padY) * w * BYTES_PER_PIXEL;
    for (let i = left; i < right; i++, p += BYTES_PER_PIXEL) {
      tensor[i] = UNIT_LUT[region[p]!]!;
      tensor[greenAt + i] = UNIT_LUT[region[p + 1]!]!;
      tensor[blueAt + i] = UNIT_LUT[region[p + 2]!]!;
    }
  }
  return tensor;
}

/** Độ sáng của điểm ảnh tại byte p, nhân LUMA_SCALE. */
function luma(d: ByteArray, p: number): number {
  return LUMA_R * d[p]! + LUMA_G * d[p + 1]! + LUMA_B * d[p + 2]!;
}

/**
 * F4 (phần thuần) — Thu nhỏ ảnh RGBA về chiều rộng thumbWidth, GIỮ tỷ lệ gốc (cao = round(h·thumbWidth/w), tối thiểu 1),
 * KHÔNG có lề, rồi đổi sang độ sáng 0,299R + 0,587G + 0,114B làm tròn về 0..255. Nội suy bilinear; chiều rộng luôn đúng thumbWidth.
 * `out` được dùng lại nếu đúng độ dài width·height, nếu không thì cấp phát mới: luôn dùng giá trị trả về.
 * @throws AppError INFERENCE_FAILED khi kích thước nguồn hoặc thumbWidth không hợp lệ, hoặc nguồn thiếu byte.
 */
export function toGray(source: RgbaImage, thumbWidth: number, out?: Uint8Array): GrayImage {
  const { data, width: srcW, height: srcH } = source;
  if (!isSize(srcW) || !isSize(srcH) || data.length < srcW * srcH * BYTES_PER_PIXEL) {
    fail(`Ảnh nguồn không hợp lệ: ${String(srcW)}×${String(srcH)}, ${data.length} byte`);
  }
  if (!isSize(thumbWidth)) fail(`thumbWidth không hợp lệ: ${String(thumbWidth)}`);

  const width = thumbWidth;
  const height = Math.max(1, Math.round((srcH * width) / srcW));
  const gray = out !== undefined && out.length === width * height ? out : new Uint8Array(width * height);
  const cols = buildAxisTable(srcW, width);
  const rows = buildAxisTable(srcH, height);
  const stride = srcW * BYTES_PER_PIXEL;
  let o = 0;
  for (let y = 0; y < height; y++) {
    const top = rows.i0[y]! * stride;
    const bottom = rows.i1[y]! * stride;
    const wy = rows.w[y]!;
    for (let x = 0; x < width; x++) {
      const a = cols.i0[x]! * BYTES_PER_PIXEL;
      const b = cols.i1[x]! * BYTES_PER_PIXEL;
      const wx = cols.w[x]!;
      const l00 = luma(data, top + a);
      const l10 = luma(data, bottom + a);
      const upper = l00 + (luma(data, top + b) - l00) * wx;
      const lower = l10 + (luma(data, bottom + b) - l10) * wx;
      gray[o++] = Math.round((upper + (lower - upper) * wy) / LUMA_SCALE);
    }
  }
  return { data: gray, width, height };
}