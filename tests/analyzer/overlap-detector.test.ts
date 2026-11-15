import { describe, expect, it } from 'vitest';
import { detectOverlap } from '../../src/analyzer/overlap-detector';
import type { BBox, Detection } from '../../src/contracts';
import { makeDetection } from '../fakes';

const OVERLAP_RATIO = 0.15;

const box = (x1: number, y1: number, x2: number, y2: number): BBox => ({ x1, y1, x2, y2 });
const det = (id: string, bbox: BBox): Detection => makeDetection({ id, bbox });

/** Hộp gốc 100 × 100 đặt ở (0, 0). */
const BASE = box(0, 0, 100, 100);

describe('detectOverlap · hai hộp', () => {
  it.each([
    { name: 'rời nhau', other: box(200, 0, 300, 100), maxRatio: 0, detected: false },
    { name: 'chỉ chạm cạnh', other: box(100, 0, 200, 100), maxRatio: 0, detected: false },
    { name: 'chồng 10 phần trăm', other: box(90, 0, 190, 100), maxRatio: 0.1, detected: false },
    { name: 'chồng đúng ngưỡng 15 phần trăm (nghiêm ngặt nên chưa tính)', other: box(85, 0, 185, 100), maxRatio: 0.15, detected: false },
    { name: 'chồng 20 phần trăm', other: box(80, 0, 180, 100), maxRatio: 0.2, detected: true },
    { name: 'hộp nhỏ nằm trọn trong hộp lớn', other: box(10, 10, 40, 40), maxRatio: 1, detected: true },
    { name: 'hai hộp trùng khít', other: box(0, 0, 100, 100), maxRatio: 1, detected: true },
  ])('$name', ({ other, maxRatio, detected }) => {
    const result = detectOverlap([det('a', BASE), det('b', other)], OVERLAP_RATIO);
    expect(result.detected).toBe(detected);
    expect(result.maxRatio).toBeCloseTo(maxRatio, 9);
    expect(result.pairs).toEqual(detected ? [['a', 'b']] : []);
  });

  it('mẫu số là hộp nhỏ hơn chứ không phải hợp (khác IoU)', () => {
    const big = box(0, 0, 200, 100);
    const small = box(190, 0, 230, 100);
    const result = detectOverlap([det('big', big), det('small', small)], OVERLAP_RATIO);
    expect(result.maxRatio).toBeCloseTo(0.25, 9);
    expect(result.detected).toBe(true);
  });
});

describe('detectOverlap · hộp suy biến', () => {
  it.each([
    { name: 'rộng bằng 0', bad: box(50, 50, 50, 80) },
    { name: 'đảo ngược', bad: box(80, 80, 20, 20) },
    { name: 'chứa NaN', bad: box(Number.NaN, 0, 50, 50) },
  ])('$name bị bỏ qua, không tạo cặp', ({ bad }) => {
    const result = detectOverlap([det('a', BASE), det('bad', bad)], OVERLAP_RATIO);
    expect(result).toEqual({ detected: false, maxRatio: 0, pairs: [] });
  });

  it('hộp suy biến không làm mất cặp chồng lấn của hai hộp hợp lệ', () => {
    const result = detectOverlap(
      [det('a', BASE), det('bad', box(10, 10, 10, 10)), det('c', box(50, 0, 150, 100))],
      OVERLAP_RATIO,
    );
    expect(result.pairs).toEqual([['a', 'c']]);
  });
});

describe('detectOverlap · nhiều hộp', () => {
  it('chỉ liệt kê cặp vượt ngưỡng, maxRatio lấy theo mọi cặp', () => {
    const result = detectOverlap(
      [det('a', BASE), det('b', box(300, 0, 400, 100)), det('c', box(70, 0, 170, 100))],
      OVERLAP_RATIO,
    );
    expect(result.pairs).toEqual([['a', 'c']]);
    expect(result.maxRatio).toBeCloseTo(0.3, 9);
  });

  it('maxRatio vẫn được báo khi chưa có cặp nào vượt ngưỡng', () => {
    const result = detectOverlap([det('a', BASE), det('b', box(90, 0, 190, 100))], OVERLAP_RATIO);
    expect(result.detected).toBe(false);
    expect(result.maxRatio).toBeCloseTo(0.1, 9);
  });

  it.each([
    { name: 'không có hộp nào', input: [] as Detection[] },
    { name: 'chỉ một hộp', input: [det('a', BASE)] },
  ])('$name thì không chồng lấn', ({ input }) => {
    expect(detectOverlap(input, OVERLAP_RATIO)).toEqual({ detected: false, maxRatio: 0, pairs: [] });
  });
});

describe('detectOverlap · không đột biến đầu vào', () => {
  it('đầu vào đóng băng vẫn chạy được và không đổi', () => {
    const input = Object.freeze([
      Object.freeze(det('a', Object.freeze(box(0, 0, 100, 100)))),
      Object.freeze(det('b', Object.freeze(box(50, 0, 150, 100)))),
    ]);
    const snapshot = JSON.stringify(input);
    expect(() => detectOverlap(input, OVERLAP_RATIO)).not.toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});