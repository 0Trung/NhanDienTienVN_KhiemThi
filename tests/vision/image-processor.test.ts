import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/contracts';
import type { AppErrorCode, PreprocessorOptions } from '../../src/contracts';
import { computeLetterbox } from '../../src/vision/letterbox';
import { createPreprocessor, createPreprocessorWith, preprocessRgba, resizeBilinearRgba } from '../../src/vision/image-processor';
import type { Context2DLike } from '../../src/vision/image-processor';
import { rgbaToTensor } from '../../src/vision/tensor';
import type { ByteArray, RgbaImage } from '../../src/vision/tensor';
import { setLogSink } from '../../src/utils/logger';

function expectAppError(run: () => unknown, code: AppErrorCode, fatal = false): AppError {
  let caught: unknown;
  try {
    run();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
  expect((caught as AppError).fatal).toBe(fatal);
  return caught as AppError;
}

type Rgb = readonly [number, number, number];
function makeRgba(w: number, h: number, colorAt: (x: number, y: number) => Rgb): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set([...colorAt(x, y), 255], (y * w + x) * 4);
  }
  return data;
}
const unit = (v: number): number => Math.fround(v / 255);

/** ImageBitmap giả: giữ điểm ảnh RGBA; sau close() width/height về 0 như ImageBitmap thật. */
class FakeBitmap {
  failDraw = false;
  private open = true;
  constructor(private readonly w: number, private readonly h: number, readonly pixels: Uint8ClampedArray) {}
  get width(): number {
    return this.open ? this.w : 0;
  }
  get height(): number {
    return this.open ? this.h : 0;
  }
  close(): void {
    this.open = false;
  }
}
const asBitmap = (b: { width: number; height: number }): ImageBitmap => b as unknown as ImageBitmap;

type Resample = (src: RgbaImage, w: number, h: number) => ByteArray;
/** Resize láng giềng gần nhất, viết độc lập với mã thật để kiểm vị trí điểm ảnh bằng tay. */
const nearest: Resample = (src, w, h) => {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = (Math.floor(((y + 0.5) * src.height) / h) * src.width + Math.floor(((x + 0.5) * src.width) / w)) * 4;
      out.set(src.data.subarray(at, at + 4), (y * w + x) * 4);
    }
  }
  return out;
};
const bilinear: Resample = (src, w, h) => resizeBilinearRgba(src, w, h);

/** Canvas 2D giả: ghi lại mọi lời gọi, vẽ vào mảng RGBA thật. */
class FakeContext implements Context2DLike {
  imageSmoothingEnabled = false;
  imageSmoothingQuality: 'low' | 'medium' | 'high' = 'high';
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  readonly fills: Array<[number, number, number, number, string]> = [];
  readonly draws: number[][] = [];
  readonly reads: number[][] = [];
  badRead: { data: Uint8ClampedArray; width: number; height: number } | null = null;
  private readonly px: Uint8ClampedArray;
  constructor(readonly size: number, private readonly resample: Resample) {
    this.px = new Uint8ClampedArray(size * size * 4);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.fills.push([x, y, w, h, String(this.fillStyle)]);
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(this.fillStyle));
    const [r, g, b] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px.set([r, g, b, 255], (j * this.size + i) * 4);
  }
  drawImage(image: ImageBitmap, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void {
    const bitmap = image as unknown as FakeBitmap;
    if (bitmap.failDraw || bitmap.width === 0) throw new DOMException('Bitmap không dùng được', 'InvalidStateError');
    this.draws.push([sx, sy, sw, sh, dx, dy, dw, dh]);
    const scaled = this.resample({ data: bitmap.pixels, width: sw, height: sh }, dw, dh);
    for (let j = 0; j < dh; j++) this.px.set(scaled.subarray(j * dw * 4, (j + 1) * dw * 4), ((dy + j) * this.size + dx) * 4);
  }
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray; width: number; height: number } {
    this.reads.push([sx, sy, sw, sh]);
    if (this.badRead) return this.badRead;
    const data = new Uint8ClampedArray(sw * sh * 4);
    for (let j = 0; j < sh; j++) {
      const from = ((sy + j) * this.size + sx) * 4;
      data.set(this.px.subarray(from, from + sw * 4), j * sw * 4);
    }
    return { data, width: sw, height: sh };
  }
}

function fakeCanvas(resample: Resample): { factory: (size: number) => Context2DLike; made: FakeContext[] } {
  const made: FakeContext[] = [];
  return {
    made,
    factory: (size) => {
      const ctx = new FakeContext(size, resample);
      made.push(ctx);
      return ctx;
    },
  };
}
function makeFrame(w: number, h: number, k: number): { bitmap: ImageBitmap; src: RgbaImage } {
  const data = makeRgba(w, h, (x, y) => [(x * k) % 256, (y * k + 3) % 256, (x + y + k) % 256]);
  return { bitmap: asBitmap(new FakeBitmap(w, h, data)), src: { data, width: w, height: h } };
}

const OPTIONS: PreprocessorOptions = { inputSize: 8, padValue: 114, grayThumbWidth: 4 };

beforeEach(() => {
  setLogSink(() => undefined); // im lặng log debug của module
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLogSink(null);
});

describe('resizeBilinearRgba — tầng thuần', () => {
  it('phóng 2×1 → 4×1: nội suy lệch nửa ô, lặp mép hai đầu', () => {
    const src = { data: Uint8Array.from([0, 10, 20, 30, 100, 110, 120, 130]), width: 2, height: 1 };
    expect(Array.from(resizeBilinearRgba(src, 4, 1))).toEqual([0, 10, 20, 30, 25, 35, 45, 55, 75, 85, 95, 105, 100, 110, 120, 130]);
  });

  it('thu nhỏ 2 lần là trung bình bốn điểm kề nhau', () => {
    const data = [0, 100, 200, 40].flatMap((v) => [v, v, v, 255]);
    expect(Array.from(resizeBilinearRgba({ data: Uint8Array.from(data), width: 2, height: 2 }, 1, 1))).toEqual([85, 85, 85, 255]);
  });

  it('giữ nguyên kích thước thì giữ nguyên điểm ảnh', () => {
    const data = makeRgba(5, 3, (x, y) => [x * 40, y * 80, 7]);
    expect(resizeBilinearRgba({ data, width: 5, height: 3 }, 5, 3)).toEqual(data);
  });

  it.each([[7, 5, 3, 2], [3, 2, 9, 7]])('ảnh một màu vẫn một màu khi đổi %i×%i → %i×%i', (sw, sh, dw, dh) => {
    const out = resizeBilinearRgba({ data: makeRgba(sw, sh, () => [12, 200, 99]), width: sw, height: sh }, dw, dh);
    expect(out).toEqual(makeRgba(dw, dh, () => [12, 200, 99]));
  });

  it('dùng lại out đúng độ dài', () => {
    const out = new Uint8ClampedArray(4 * 4);
    expect(resizeBilinearRgba({ data: makeRgba(2, 2, () => [1, 1, 1]), width: 2, height: 2 }, 2, 2, out)).toBe(out);
  });

  it.each([[0, 2, 2, 2], [2, 2, 0, 2], [2, 2, 2.5, 2]])('kích thước %i×%i → %i×%i không hợp lệ ném INFERENCE_FAILED', (sw, sh, dw, dh) => {
    expectAppError(() => resizeBilinearRgba({ data: new Uint8Array(64), width: sw, height: sh }, dw, dh), 'INFERENCE_FAILED');
  });
});

describe('preprocessRgba — tầng thuần', () => {
  it('ảnh đã đúng cỡ vuông thì không resize: tensor bằng rgbaToTensor trực tiếp', () => {
    const data = makeRgba(8, 8, (x, y) => [x * 30, y * 30, 5]);
    const r = preprocessRgba({ data, width: 8, height: 8 }, OPTIONS);
    expect(r.tensor).toEqual(rgbaToTensor(data, computeLetterbox(8, 8, 8)));
  });
});

describe('createPreprocessorWith — tầng Canvas', () => {
  // Nguồn 4×2 vào ảnh 8×8: nhân đôi mỗi chiều → vùng ảnh 8×4 tại (0,2), mỗi điểm nguồn thành khối 2×2.
  const colorAt = (x: number, y: number): Rgb => [20 + 40 * x, 30 + 100 * y, 200 - 10 * x - 20 * y];
  function run() {
    const canvas = fakeCanvas(nearest);
    const bitmap = asBitmap(new FakeBitmap(4, 2, makeRgba(4, 2, colorAt)));
    return { ...canvas, result: createPreprocessorWith(OPTIONS, canvas.factory).process(bitmap) };
  }

  it('tô nền 114 cả khung, vẽ vào (padX, padY, newW, newH), chỉ đọc lại vùng ảnh', () => {
    const { made, result } = run();
    const ctx = made[0]!;
    expect(result.letterbox).toEqual(computeLetterbox(4, 2, 8));
    expect(ctx.size).toBe(8);
    expect(ctx.fills).toEqual([[0, 0, 8, 8, 'rgb(114,114,114)']]);
    expect(ctx.draws).toEqual([[0, 0, 4, 2, 0, 2, 8, 4]]);
    expect(ctx.reads).toEqual([[0, 2, 8, 4]]);
    expect([ctx.imageSmoothingEnabled, ctx.imageSmoothingQuality]).toEqual([true, 'low']);
  });

  it('tensor đúng từng phần tử: khối màu nguồn trong vùng ảnh, 114/255 ở lề', () => {
    const { result } = run();
    expect(result.tensor.length).toBe(3 * 8 * 8);
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const inside = y >= 2 && y < 6;
          const expected = inside ? colorAt(Math.floor(x / 2), Math.floor((y - 2) / 2))[c]! : 114;
          expect(result.tensor[c * 64 + y * 8 + x], `kênh ${c} (${x},${y})`).toBe(unit(expected));
        }
      }
    }
  });

  it('padValue tuỳ chọn được dùng cho cả nền canvas lẫn lề tensor', () => {
    const canvas = fakeCanvas(nearest);
    const pre = createPreprocessorWith({ ...OPTIONS, padValue: 200 }, canvas.factory);
    const { tensor } = pre.process(asBitmap(new FakeBitmap(4, 2, makeRgba(4, 2, colorAt))));
    expect(canvas.made[0]!.fills[0]![4]).toBe('rgb(200,200,200)');
    expect([tensor[0], tensor[64], tensor[128]]).toEqual([unit(200), unit(200), unit(200)]); // điểm (0,0): lề trên
  });

  it('ảnh xám lấy từ vùng ảnh nên không lẫn lề: bằng độ sáng điểm nguồn, tỷ lệ 2:1', () => {
    const { result } = run();
    expect([result.gray.width, result.gray.height]).toEqual([4, 2]);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) {
        const [r, g, b] = colorAt(x, y);
        expect(result.gray.data[y * 4 + x]).toBe(Math.round(0.299 * r + 0.587 * g + 0.114 * b));
      }
    }
  });

  it('khớp tầng thuần trên ảnh có kết cấu (cùng computeLetterbox, rgbaToTensor, toGray)', () => {
    const opts = { inputSize: 16, padValue: 114, grayThumbWidth: 8 };
    const frame = makeFrame(30, 20, 7);
    const viaCanvas = createPreprocessorWith(opts, fakeCanvas(bilinear).factory).process(frame.bitmap);
    expect(viaCanvas).toEqual(preprocessRgba(frame.src, opts));
  });

  it('tạo canvas một lần, tái sử dụng buffer khi cùng cỡ, không lẫn dữ liệu khi đổi tỷ lệ', () => {
    const opts = { inputSize: 16, padValue: 114, grayThumbWidth: 8 };
    const { factory, made } = fakeCanvas(bilinear);
    const pre = createPreprocessorWith(opts, factory);
    const [a1, a2, b] = [makeFrame(30, 20, 7), makeFrame(30, 20, 13), makeFrame(12, 36, 5)];
    expect(made).toHaveLength(0); // canvas tạo muộn, khi có khung đầu tiên
    const r1 = pre.process(a1.bitmap);
    const r2 = pre.process(a2.bitmap);
    expect(r2.tensor).toBe(r1.tensor);
    expect(r2.gray.data).toBe(r1.gray.data);
    expect(r2).toEqual(preprocessRgba(a2.src, opts));
    const r3 = pre.process(b.bitmap); // dọc: lề trái/phải thay lề trên/dưới, ảnh xám cao hơn
    expect(r3.tensor).toBe(r1.tensor);
    expect(r3.gray.data).not.toBe(r1.gray.data);
    expect(r3).toEqual(preprocessRgba(b.src, opts));
    expect(made).toHaveLength(1);
  });

  it('buffer bị transfer (detach) thì khung sau tự cấp phát lại và vẫn đúng', () => {
    const pre = createPreprocessorWith(OPTIONS, fakeCanvas(bilinear).factory);
    const frame = makeFrame(4, 2, 3);
    const first = pre.process(frame.bitmap);
    const buffers = [first.tensor.buffer, first.gray.data.buffer];
    structuredClone(buffers, { transfer: buffers });
    expect(first.tensor.length).toBe(0);
    expect(pre.process(frame.bitmap)).toEqual(preprocessRgba(frame.src, OPTIONS));
  });

  const BAD_OPTIONS: ReadonlyArray<readonly [string, Partial<PreprocessorOptions>]> = [
    ['inputSize = 0', { inputSize: 0 }],
    ['inputSize không nguyên', { inputSize: 416.5 }],
    ['padValue > 255', { padValue: 256 }],
    ['padValue NaN', { padValue: Number.NaN }],
    ['grayThumbWidth = 0', { grayThumbWidth: 0 }],
    ['grayThumbWidth không nguyên', { grayThumbWidth: 12.5 }],
  ];
  it.each(BAD_OPTIONS)('tuỳ chọn sai (%s) ném AppError INFERENCE_FAILED fatal', (_label, patch) => {
    expectAppError(() => createPreprocessorWith({ ...OPTIONS, ...patch }, fakeCanvas(bilinear).factory), 'INFERENCE_FAILED', true);
  });
});

describe('F6 — kiểm tra đầu vào', () => {
  it('bitmap đã close() ném INFERENCE_FAILED trước khi đụng canvas', () => {
    const { factory, made } = fakeCanvas(bilinear);
    const bitmap = new FakeBitmap(4, 2, makeRgba(4, 2, () => [1, 2, 3]));
    bitmap.close();
    const error = expectAppError(() => createPreprocessorWith(OPTIONS, factory).process(asBitmap(bitmap)), 'INFERENCE_FAILED');
    expect(error.message).toContain('đã đóng');
    expect(made).toHaveLength(0);
  });

  it.each([[0, 480], [640, 0], [0, 0]])('bitmap %i×%i ném INFERENCE_FAILED', (width, height) => {
    expectAppError(() => createPreprocessorWith(OPTIONS, fakeCanvas(bilinear).factory).process(asBitmap({ width, height })), 'INFERENCE_FAILED');
  });

  it('canvas ném lỗi khi vẽ: AppError giữ nguyên nhân, khung kế vẫn xử lý đúng', () => {
    const pre = createPreprocessorWith(OPTIONS, fakeCanvas(bilinear).factory);
    const good = makeFrame(4, 2, 3);
    const broken = new FakeBitmap(4, 2, new Uint8ClampedArray(32));
    broken.failDraw = true;
    const error = expectAppError(() => pre.process(asBitmap(broken)), 'INFERENCE_FAILED');
    expect(error.detail).toBeInstanceOf(DOMException);
    expect(pre.process(good.bitmap)).toEqual(preprocessRgba(good.src, OPTIONS));
  });

  it('getImageData trả vùng sai kích thước thì ném lỗi, không trả tensor', () => {
    const { factory, made } = fakeCanvas(bilinear);
    const pre = createPreprocessorWith(OPTIONS, factory);
    const frame = makeFrame(4, 2, 3);
    pre.process(frame.bitmap);
    made[0]!.badRead = { data: new Uint8ClampedArray(8 * 4 * 4), width: 4, height: 8 }; // đủ byte nhưng sai hình dạng (cần 8×4)
    expect(expectAppError(() => pre.process(frame.bitmap), 'INFERENCE_FAILED').message).toContain('sai kích thước');
    made[0]!.badRead = null;
    expect(pre.process(frame.bitmap)).toEqual(preprocessRgba(frame.src, OPTIONS));
  });
});

describe('createPreprocessor — canvas thật', () => {
  const frame = makeFrame(4, 2, 3);

  it('môi trường không có canvas (Node) ném UNSUPPORTED_BROWSER fatal', () => {
    const error = expectAppError(() => createPreprocessor(OPTIONS).process(frame.bitmap), 'UNSUPPORTED_BROWSER', true);
    expect(error.message).toContain('OffscreenCanvas');
  });

  it('ưu tiên OffscreenCanvas S×S với willReadFrequently', () => {
    const created: number[][] = [];
    const getContextSpy = vi.fn(() => new FakeContext(8, bilinear));
    vi.stubGlobal('OffscreenCanvas', class {
      getContext = getContextSpy;
      constructor(w: number, h: number) {
        created.push([w, h]);
      }
    });
    expect(createPreprocessor(OPTIONS).process(frame.bitmap)).toEqual(preprocessRgba(frame.src, OPTIONS));
    expect(created).toEqual([[8, 8]]);
    expect(getContextSpy).toHaveBeenCalledWith('2d', { willReadFrequently: true, alpha: false });
  });

  it('thiếu OffscreenCanvas thì dùng canvas DOM cỡ S×S', () => {
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => new FakeContext(8, bilinear)) };
    const createElement = vi.fn(() => canvas);
    vi.stubGlobal('document', { createElement });
    expect(createPreprocessor(OPTIONS).process(frame.bitmap)).toEqual(preprocessRgba(frame.src, OPTIONS));
    expect(createElement).toHaveBeenCalledWith('canvas');
    expect([canvas.width, canvas.height]).toEqual([8, 8]);
    expect(canvas.getContext).toHaveBeenCalledWith('2d', { willReadFrequently: true, alpha: false });
  });
});