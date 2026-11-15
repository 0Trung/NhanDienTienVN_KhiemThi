import { describe, expect, it } from 'vitest';
import { BLUR_MIN_REGION_SIDE, BLUR_NOT_ENOUGH_DATA, measureBlur } from '../../src/analyzer/blur-detector';
import type { BBox, GrayImage } from '../../src/contracts';
import { makeGray } from '../fakes';

const BLUR_THRESHOLD = 60;
const NO_BOXES: BBox[] = [];

const box = (x1: number, y1: number, x2: number, y2: number): BBox => ({ x1, y1, x2, y2 });
/** Khung gốc trùng kích thước ảnh xám (tỷ lệ 1:1) để toạ độ hộp chính là toạ độ điểm ảnh. */
const frameOf = (g: GrayImage) => ({ width: g.width, height: g.height });

/** Ảnh bàn cờ đen (0) trắng (255), mỗi ô `cell` điểm: ảnh rất nét. */
function checkerboard(width: number, height: number, cell: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0 : 255;
    }
  }
  return { data, width, height };
}

/** Làm mờ bằng trung bình hộp (2r+1)², biên lặp điểm gần nhất, làm tròn về số nguyên, lặp `passes` lần. */
function boxBlur(src: GrayImage, radius: number, passes = 1): GrayImage {
  let current = src;
  for (let p = 0; p < passes; p++) {
    const out = new Uint8Array(current.data.length);
    for (let y = 0; y < current.height; y++) {
      for (let x = 0; x < current.width; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = Math.min(current.width - 1, Math.max(0, x + dx));
            const yy = Math.min(current.height - 1, Math.max(0, y + dy));
            sum += current.data[yy * current.width + xx] ?? 0;
            n++;
          }
        }
        out[y * current.width + x] = Math.round(sum / n);
      }
    }
    current = { data: out, width: current.width, height: current.height };
  }
  return current;
}

/** Trả bản sao của `base` với hình chữ nhật [x0,x1) × [y0,y1) được thay bằng `fill`. */
function paint(base: GrayImage, x0: number, y0: number, x1: number, y1: number, fill: (x: number, y: number) => number): GrayImage {
  const data = base.data.slice();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) data[y * base.width + x] = fill(x, y);
  }
  return { data, width: base.width, height: base.height };
}

const checkerFill = (cell: number) => (x: number, y: number) => ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0 : 255);

describe('measureBlur · ảnh tổng hợp (không hộp, tính trên vùng giữa)', () => {
  it('ảnh phẳng cho điểm 0 và bị coi là mờ', () => {
    const gray = makeGray(64, 64, 128);
    expect(measureBlur(gray, frameOf(gray), NO_BOXES, BLUR_THRESHOLD)).toEqual({ blurScore: 0, blurry: true });
  });

  it('ô vuông sắc nét thì không mờ và điểm vượt xa ngưỡng', () => {
    const gray = checkerboard(64, 64, 4);
    const result = measureBlur(gray, frameOf(gray), NO_BOXES, BLUR_THRESHOLD);
    expect(result.blurry).toBe(false);
    expect(result.blurScore).toBeGreaterThan(BLUR_THRESHOLD * 100);
  });

  it('bản làm mờ bằng trung bình hộp thì mờ và điểm thấp hơn bản nét', () => {
    const sharp = checkerboard(64, 64, 4);
    const blurred = boxBlur(sharp, 3, 2);
    const sharpScore = measureBlur(sharp, frameOf(sharp), NO_BOXES, BLUR_THRESHOLD).blurScore;
    const blurredResult = measureBlur(blurred, frameOf(blurred), NO_BOXES, BLUR_THRESHOLD);
    expect(blurredResult.blurry).toBe(true);
    expect(blurredResult.blurScore).toBeGreaterThanOrEqual(0);
    expect(blurredResult.blurScore).toBeLessThan(sharpScore);
  });

  it('làm mờ càng nhiều thì điểm càng thấp', () => {
    const sharp = checkerboard(64, 64, 4);
    const scores = [sharp, boxBlur(sharp, 1), boxBlur(sharp, 2), boxBlur(sharp, 3)].map(
      (g) => measureBlur(g, frameOf(g), NO_BOXES, BLUR_THRESHOLD).blurScore,
    );
    expect(scores[0]).toBeGreaterThan(scores[1] ?? Infinity);
    expect(scores[1]).toBeGreaterThan(scores[2] ?? Infinity);
    expect(scores[2]).toBeGreaterThan(scores[3] ?? Infinity);
  });
});

describe('measureBlur · giá trị Laplacian', () => {
  it('một điểm sáng trên nền đen cho đúng phương sai tính tay', () => {
    // Tại điểm sáng: -4·255 = -1020; bốn điểm lân cận: +255 mỗi điểm; tổng = 0.
    // Vùng đo = 18 × 18 = 324 điểm trong; Σ L² = 1020² + 4·255² = 1 300 500.
    const gray = makeGray(20, 20, 0);
    gray.data[10 * 20 + 10] = 255;
    const result = measureBlur(gray, frameOf(gray), [box(0, 0, 20, 20)], BLUR_THRESHOLD);
    expect(result.blurScore).toBeCloseTo(1_300_500 / 324, 6);
  });

  it('so sánh ngưỡng nghiêm ngặt: điểm đúng bằng ngưỡng thì chưa mờ', () => {
    const gray = boxBlur(checkerboard(64, 64, 4), 2);
    const score = measureBlur(gray, frameOf(gray), NO_BOXES, BLUR_THRESHOLD).blurScore;
    expect(measureBlur(gray, frameOf(gray), NO_BOXES, score).blurry).toBe(false);
    expect(measureBlur(gray, frameOf(gray), NO_BOXES, score + 1).blurry).toBe(true);
  });
});

describe('measureBlur · vùng đo theo hộp', () => {
  it('chỉ tính trong hộp: hộp nằm trên vùng phẳng thì điểm 0 dù ngoài hộp rất nét', () => {
    const gray = paint(checkerboard(64, 64, 4), 16, 16, 48, 48, () => 128);
    const inBox = measureBlur(gray, frameOf(gray), [box(20, 20, 44, 44)], BLUR_THRESHOLD);
    expect(inBox).toEqual({ blurScore: 0, blurry: true });
    expect(measureBlur(gray, frameOf(gray), NO_BOXES, BLUR_THRESHOLD).blurScore).toBeGreaterThan(0);
  });

  it('hộp nằm trên vùng nét thì không mờ dù nền ngoài hộp phẳng', () => {
    const gray = paint(makeGray(96, 96, 128), 40, 40, 80, 80, checkerFill(4));
    const textured = measureBlur(gray, frameOf(gray), [box(40, 40, 80, 80)], BLUR_THRESHOLD);
    const flat = measureBlur(gray, frameOf(gray), [box(2, 2, 34, 34)], BLUR_THRESHOLD);
    expect(textured.blurry).toBe(false);
    expect(flat).toEqual({ blurScore: 0, blurry: true });
  });

  it('quy hộp từ pixel khung gốc về toạ độ ảnh xám: kết quả trùng với hộp tương ứng trong toạ độ ảnh xám', () => {
    const gray = paint(makeGray(64, 48, 128), 20, 15, 44, 33, checkerFill(4));
    const scaled = measureBlur(gray, { width: 640, height: 480 }, [box(200, 150, 440, 330)], BLUR_THRESHOLD);
    const direct = measureBlur(gray, { width: 64, height: 48 }, [box(20, 15, 44, 33)], BLUR_THRESHOLD);
    expect(scaled.blurScore).toBeGreaterThan(BLUR_THRESHOLD);
    expect(scaled.blurScore).toBeCloseTo(direct.blurScore, 9);
  });

  it('vùng hợp: hộp trùng nhau hoặc nằm trong hộp khác không bị đếm hai lần', () => {
    const gray = paint(makeGray(96, 96, 128), 20, 20, 76, 76, checkerFill(4));
    const single = measureBlur(gray, frameOf(gray), [box(20, 20, 76, 76)], BLUR_THRESHOLD).blurScore;
    const duplicated = measureBlur(gray, frameOf(gray), [box(20, 20, 76, 76), box(20, 20, 76, 76)], BLUR_THRESHOLD).blurScore;
    const nested = measureBlur(gray, frameOf(gray), [box(20, 20, 76, 76), box(30, 30, 60, 60)], BLUR_THRESHOLD).blurScore;
    expect(duplicated).toBeCloseTo(single, 9);
    expect(nested).toBeCloseTo(single, 9);
  });

  it('vùng hợp của hai hộp rời nhau: thêm hộp phẳng làm loãng phương sai', () => {
    const gray = paint(makeGray(96, 48, 128), 8, 8, 40, 40, checkerFill(4));
    const onlyTextured = measureBlur(gray, frameOf(gray), [box(8, 8, 40, 40)], BLUR_THRESHOLD).blurScore;
    const both = measureBlur(gray, frameOf(gray), [box(8, 8, 40, 40), box(56, 8, 88, 40)], BLUR_THRESHOLD).blurScore;
    expect(both).toBeGreaterThan(0);
    expect(both).toBeLessThan(onlyTextured);
  });
});

describe('measureBlur · không có hộp thì dùng 60 phần trăm vùng giữa', () => {
  it('nền nét chỉ nằm ngoài vùng giữa thì điểm 0', () => {
    const outerOnly = paint(makeGray(100, 100, 128), 0, 0, 100, 100, (x, y) =>
      x < 10 || x >= 90 || y < 10 || y >= 90 ? checkerFill(4)(x, y) : 128,
    );
    expect(measureBlur(outerOnly, frameOf(outerOnly), NO_BOXES, BLUR_THRESHOLD)).toEqual({ blurScore: 0, blurry: true });
  });

  it('chi tiết nét nằm trong vùng giữa thì được tính', () => {
    const centerOnly = paint(makeGray(100, 100, 128), 25, 25, 75, 75, checkerFill(4));
    const result = measureBlur(centerOnly, frameOf(centerOnly), NO_BOXES, BLUR_THRESHOLD);
    expect(result.blurry).toBe(false);
    expect(result.blurScore).toBeGreaterThan(BLUR_THRESHOLD);
  });

  it('hộp suy biến bị bỏ qua nên cũng rơi về vùng giữa', () => {
    const centerOnly = paint(makeGray(100, 100, 128), 25, 25, 75, 75, checkerFill(4));
    const withBad = measureBlur(centerOnly, frameOf(centerOnly), [box(50, 50, 50, 90), box(90, 90, 10, 10)], BLUR_THRESHOLD);
    const noBoxes = measureBlur(centerOnly, frameOf(centerOnly), NO_BOXES, BLUR_THRESHOLD);
    expect(withBad).toEqual(noBoxes);
  });
});

describe('measureBlur · không đủ dữ liệu (blurScore -1, blurry false)', () => {
  const insufficient = { blurScore: BLUR_NOT_ENOUGH_DATA, blurry: false };

  it('ảnh xám nhỏ khiến vùng giữa dưới 16 × 16 điểm', () => {
    const gray = checkerboard(15, 15, 2);
    expect(measureBlur(gray, frameOf(gray), NO_BOXES, BLUR_THRESHOLD)).toEqual(insufficient);
  });

  it('hộp 10 × 10 điểm là quá nhỏ', () => {
    const gray = checkerboard(64, 64, 4);
    expect(measureBlur(gray, frameOf(gray), [box(20, 20, 30, 30)], BLUR_THRESHOLD)).toEqual(insufficient);
  });

  it('hộp nằm hoàn toàn ngoài khung', () => {
    const gray = checkerboard(64, 48, 4);
    expect(measureBlur(gray, { width: 640, height: 480 }, [box(700, 500, 800, 600)], BLUR_THRESHOLD)).toEqual(insufficient);
  });

  it('ranh giới: hộp 16 × 16 điểm trong ảnh thì đủ, hộp 15 × 16 điểm thì không', () => {
    const gray = checkerboard(64, 64, 4);
    const enough = measureBlur(gray, frameOf(gray), [box(20, 20, 20 + BLUR_MIN_REGION_SIDE, 20 + BLUR_MIN_REGION_SIDE)], BLUR_THRESHOLD);
    const notEnough = measureBlur(gray, frameOf(gray), [box(20, 20, 20 + BLUR_MIN_REGION_SIDE - 1, 20 + BLUR_MIN_REGION_SIDE)], BLUR_THRESHOLD);
    expect(enough.blurScore).toBeGreaterThan(0);
    expect(notEnough).toEqual(insufficient);
  });

  it.each([
    { name: 'hộp 15 × 17 = 255 điểm (thiếu đúng một điểm so với 256)', region: box(20, 20, 35, 37) },
    { name: 'hộp 17 × 15 = 255 điểm (thiếu đúng một điểm so với 256)', region: box(20, 20, 37, 35) },
  ])('ranh giới số điểm: $name', ({ region }) => {
    const gray = checkerboard(64, 64, 4);
    expect(measureBlur(gray, frameOf(gray), [region], BLUR_THRESHOLD)).toEqual(insufficient);
  });

  it.each([
    { name: 'ảnh xám nhỏ hơn 3 × 3', gray: makeGray(2, 2, 100) },
    { name: 'dữ liệu ngắn hơn width × height', gray: { data: new Uint8Array(10), width: 64, height: 64 } as GrayImage },
    { name: 'ảnh rỗng', gray: { data: new Uint8Array(0), width: 0, height: 0 } as GrayImage },
  ])('$name', ({ gray }) => {
    expect(measureBlur(gray, { width: 640, height: 480 }, NO_BOXES, BLUR_THRESHOLD)).toEqual(insufficient);
  });

  it('có hộp hợp lệ nhưng kích thước khung không hợp lệ', () => {
    const gray = checkerboard(64, 64, 4);
    expect(measureBlur(gray, { width: 0, height: 0 }, [box(10, 10, 50, 50)], BLUR_THRESHOLD)).toEqual(insufficient);
  });
});

describe('measureBlur · không đột biến đầu vào', () => {
  it('dữ liệu ảnh và mảng hộp đóng băng vẫn chạy được và không đổi', () => {
    const gray = checkerboard(64, 64, 4);
    const before = Array.from(gray.data);
    const boxes = Object.freeze([Object.freeze(box(10, 10, 50, 50))]);
    expect(() => measureBlur(gray, frameOf(gray), boxes, BLUR_THRESHOLD)).not.toThrow();
    expect(Array.from(gray.data)).toEqual(before);
    expect(boxes).toEqual([box(10, 10, 50, 50)]);
  });
});