import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/contracts';
import type { AppErrorCode, LetterboxMeta } from '../../src/contracts';
import { computeLetterbox } from '../../src/vision/letterbox';
import { buildAxisTable, rgbaToTensor, toGray } from '../../src/vision/tensor';

function expectAppError(run: () => unknown, code: AppErrorCode): void {
  let caught: unknown;
  try {
    run();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
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

/** Vùng ảnh 2×2 dán vào tensor 4×4 tại (1,1). */
const META_2X2: LetterboxMeta = { inputSize: 4, srcWidth: 2, srcHeight: 2, scale: 1, newWidth: 2, newHeight: 2, padX: 1, padY: 1 };
const PIXELS: ReadonlyArray<readonly [number, number, Rgb]> = [
  [1, 1, [255, 0, 0]],
  [2, 1, [0, 255, 0]],
  [1, 2, [0, 0, 255]],
  [2, 2, [10, 20, 30]],
];
const REGION_2X2 = Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 7]); // alpha bị bỏ qua

describe('rgbaToTensor', () => {
  it.each(PIXELS)('điểm (%i,%i) nằm đúng chỗ, đủ ba kênh R,G,B theo thứ tự NCHW', (x, y, rgb) => {
    const tensor = rgbaToTensor(REGION_2X2, META_2X2);
    expect(tensor.length).toBe(3 * 4 * 4);
    rgb.forEach((value, c) => expect(tensor[c * 16 + y * 4 + x]).toBe(unit(value)));
  });

  it('vùng lề bằng 114/255 ở cả ba kênh, không đâu khác bị tô nền', () => {
    const tensor = rgbaToTensor(REGION_2X2, META_2X2);
    const inside = new Set(PIXELS.map(([x, y]) => y * 4 + x));
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 16; i++) if (!inside.has(i)) expect(tensor[c * 16 + i]).toBe(unit(114));
    }
  });

  it.each([0, 114, 255])('padValue = %i làm nền lề đúng giá trị', (pad) => {
    expect(rgbaToTensor(REGION_2X2, META_2X2, undefined, pad)[0]).toBe(unit(pad));
  });

  it('chia 255 đúng từng giá trị 0..255 (bằng phép chia float32 của numpy ở bản mẫu P01)', () => {
    const region = new Uint8ClampedArray(256 * 4);
    for (let v = 0; v < 256; v++) region.set([v, v, v, 255], v * 4);
    const meta = { ...META_2X2, inputSize: 256, newWidth: 256, newHeight: 1, padX: 0, padY: 0 };
    const tensor = rgbaToTensor(region, meta);
    for (let v = 0; v < 256; v++) for (let c = 0; c < 3; c++) expect(tensor[c * 65536 + v]).toBe(unit(v));
  });

  it('dùng lại out: cùng tham chiếu và không sót dữ liệu của khung trước', () => {
    const full = computeLetterbox(4, 4, 4);
    const out = rgbaToTensor(makeRgba(4, 4, () => [255, 255, 255]), full);
    const wide = computeLetterbox(4, 2, 4); // lề trên/dưới 1 hàng
    const region = makeRgba(wide.newWidth, wide.newHeight, () => [0, 0, 0]);
    const second = rgbaToTensor(region, wide, out);
    expect(second).toBe(out);
    expect(second).toEqual(rgbaToTensor(region, wide));
    expect(second[0]).toBe(unit(114)); // hàng lề trên khung 2 vốn là điểm trắng của khung 1
  });

  it.each([['sai độ dài', new Float32Array(5)], ['đã bị detach', new Float32Array(0)]])(
    'out %s thì cấp phát mảng mới đúng độ dài',
    (_label, out) => {
      const tensor = rgbaToTensor(REGION_2X2, META_2X2, out);
      expect(tensor).not.toBe(out);
      expect(tensor.length).toBe(48);
    },
  );

  const INVALID: ReadonlyArray<readonly [string, Uint8ClampedArray, Partial<LetterboxMeta>, number]> = [
    ['vùng ảnh thiếu byte', new Uint8ClampedArray(8), {}, 114],
    ['vùng ảnh tràn ra phải', REGION_2X2, { padX: 3 }, 114],
    ['vùng ảnh tràn xuống dưới', REGION_2X2, { padY: 3 }, 114],
    ['lề âm', REGION_2X2, { padX: -1 }, 114],
    ['cạnh không nguyên', REGION_2X2, { newWidth: 1.5 }, 114],
    ['inputSize = 0', REGION_2X2, { inputSize: 0 }, 114],
    ['padValue > 255', REGION_2X2, {}, 300],
    ['padValue NaN', REGION_2X2, {}, Number.NaN],
  ];
  it.each(INVALID)('%s ném AppError INFERENCE_FAILED', (_label, region, patch, pad) => {
    expectAppError(() => rgbaToTensor(region, { ...META_2X2, ...patch }, undefined, pad), 'INFERENCE_FAILED');
  });
});

describe('toGray', () => {
  const LUMA: ReadonlyArray<readonly [Rgb, number]> = [
    [[0, 0, 0], 0],
    [[255, 255, 255], 255],
    [[255, 0, 0], 76], // 76,245
    [[0, 255, 0], 150], // 149,685
    [[0, 0, 255], 29], // 29,07
    [[200, 100, 50], 124], // 124,2
    [[10, 20, 30], 18], // 18,15
  ];
  it.each(LUMA)('ảnh một màu %j có độ sáng %i ở mọi điểm', (rgb, expected) => {
    const gray = toGray({ data: makeRgba(100, 30, () => rgb), width: 100, height: 30 }, 50);
    expect(gray.data.length).toBe(gray.width * gray.height);
    expect(new Set(gray.data)).toEqual(new Set([expected]));
  });

  const RATIOS: ReadonlyArray<readonly [number, number, number, number, number]> = [
    [320, 180, 160, 160, 90],
    [180, 320, 90, 90, 160],
    [100, 30, 256, 256, 77], // 76,8 làm tròn
    [64, 64, 64, 64, 64],
    [40, 20, 64, 64, 32], // nguồn nhỏ hơn thumbWidth: chiều rộng vẫn đúng thumbWidth
    [1000, 1, 256, 256, 1], // cao tối thiểu 1
  ];
  it.each(RATIOS)('%i×%i thu về rộng %i → %i×%i (giữ tỷ lệ, không lề)', (w, h, thumb, gw, gh) => {
    const gray = toGray({ data: makeRgba(w, h, () => [90, 90, 90]), width: w, height: h }, thumb);
    expect([gray.width, gray.height]).toEqual([gw, gh]);
  });

  it('thu nhỏ bằng nội suy: mỗi điểm ra là trung bình hai điểm nguồn kề nhau', () => {
    const src = [0, 100, 100, 200].flatMap((v) => [v, v, v, 255]);
    expect(Array.from(toGray({ data: Uint8Array.from(src), width: 4, height: 1 }, 2).data)).toEqual([50, 150]);
  });

  it('dùng lại out khi đúng độ dài, cấp phát mới khi đổi kích thước', () => {
    const src = { data: makeRgba(8, 4, () => [100, 100, 100]), width: 8, height: 4 };
    const first = toGray(src, 4);
    expect(toGray({ ...src, data: makeRgba(8, 4, () => [30, 30, 30]) }, 4, first.data).data).toBe(first.data);
    expect(first.data[0]).toBe(30);
    expect(toGray({ data: makeRgba(8, 8, () => [1, 1, 1]), width: 8, height: 8 }, 4, first.data).data).not.toBe(first.data);
  });

  const BAD = makeRgba(4, 2, () => [0, 0, 0]);
  const INVALID: ReadonlyArray<readonly [string, () => unknown]> = [
    ['rộng nguồn = 0', () => toGray({ data: BAD, width: 0, height: 2 }, 2)],
    ['nguồn thiếu byte', () => toGray({ data: BAD, width: 40, height: 20 }, 2)],
    ['thumbWidth = 0', () => toGray({ data: BAD, width: 4, height: 2 }, 0)],
    ['thumbWidth không nguyên', () => toGray({ data: BAD, width: 4, height: 2 }, 2.5)],
    ['thumbWidth NaN', () => toGray({ data: BAD, width: 4, height: 2 }, Number.NaN)],
  ];
  it.each(INVALID)('%s ném AppError INFERENCE_FAILED', (_label, run) => {
    expectAppError(run, 'INFERENCE_FAILED');
  });
});

describe('buildAxisTable', () => {
  const TABLES: ReadonlyArray<readonly [number, number, number[], number[], number[]]> = [
    [2, 4, [0, 0, 0, 1], [0, 1, 1, 1], [0, 0.25, 0.75, 0]], // phóng to: lặp mép hai đầu
    [4, 2, [0, 2], [1, 3], [0.5, 0.5]], // thu nhỏ 2 lần: trung bình hai điểm
    [3, 3, [0, 1, 2], [1, 2, 2], [0, 0, 0]], // giữ nguyên: trọng số 0
    [1, 3, [0, 0, 0], [0, 0, 0], [0, 0, 0]], // nguồn một điểm
  ];
  it.each(TABLES)('%i → %i', (src, dst, i0, i1, w) => {
    const t = buildAxisTable(src, dst);
    expect([Array.from(t.i0), Array.from(t.i1), Array.from(t.w)]).toEqual([i0, i1, w]);
  });
});