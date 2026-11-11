import { describe, expect, it } from 'vitest';
import type { BBox } from '../../src/contracts';
import { area, center, clampBox, intersectionArea, iou, isValidBox, overlapOverMin } from '../../src/utils/geometry';

const box = (x1: number, y1: number, x2: number, y2: number): BBox => ({ x1, y1, x2, y2 });

describe('area', () => {
  it.each([
    { name: 'hộp thường', b: box(0, 0, 10, 5), expected: 50 },
    { name: 'rộng bằng 0', b: box(5, 5, 5, 10), expected: 0 },
    { name: 'đảo ngược', b: box(10, 10, 0, 0), expected: 0 },
    { name: 'chứa NaN', b: box(Number.NaN, 0, 1, 1), expected: 0 },
  ])('$name', ({ b, expected }) => {
    expect(area(b)).toBe(expected);
  });
});

describe('intersectionArea', () => {
  it.each([
    { name: 'chồng một phần', a: box(0, 0, 10, 10), b: box(5, 5, 15, 15), expected: 25 },
    { name: 'rời nhau', a: box(0, 0, 10, 10), b: box(20, 20, 30, 30), expected: 0 },
    { name: 'chỉ chạm cạnh', a: box(0, 0, 10, 10), b: box(10, 0, 20, 10), expected: 0 },
  ])('$name', ({ a, b, expected }) => {
    expect(intersectionArea(a, b)).toBe(expected);
  });
});

describe('iou', () => {
  it.each([
    { name: 'hai hộp giống hệt', a: box(0, 0, 10, 10), b: box(0, 0, 10, 10), expected: 1 },
    { name: 'hai hộp rời nhau', a: box(0, 0, 10, 10), b: box(20, 20, 30, 30), expected: 0 },
    { name: 'chỉ chạm cạnh', a: box(0, 0, 10, 10), b: box(10, 0, 20, 10), expected: 0 },
    { name: 'chồng một nửa chiều rộng', a: box(0, 0, 10, 10), b: box(5, 0, 15, 10), expected: 1 / 3 },
    { name: 'một hộp suy biến', a: box(0, 0, 10, 10), b: box(5, 5, 5, 5), expected: 0 },
    { name: 'cả hai hộp suy biến', a: box(1, 1, 1, 1), b: box(1, 1, 1, 1), expected: 0 },
  ])('$name', ({ a, b, expected }) => {
    expect(iou(a, b)).toBeCloseTo(expected, 6);
  });
});

describe('overlapOverMin', () => {
  it.each([
    { name: 'hộp nhỏ nằm trọn trong hộp lớn', a: box(0, 0, 100, 100), b: box(10, 10, 20, 20), expected: 1 },
    { name: 'chồng một nửa hai hộp bằng nhau', a: box(0, 0, 10, 10), b: box(5, 0, 15, 10), expected: 0.5 },
    { name: 'hai hộp rời nhau', a: box(0, 0, 10, 10), b: box(20, 20, 30, 30), expected: 0 },
    { name: 'một hộp suy biến', a: box(0, 0, 10, 10), b: box(5, 5, 5, 8), expected: 0 },
  ])('$name', ({ a, b, expected }) => {
    expect(overlapOverMin(a, b)).toBeCloseTo(expected, 6);
  });
});

describe('center', () => {
  it('trả tâm hộp', () => {
    expect(center(box(0, 10, 10, 30))).toEqual({ x: 5, y: 20 });
  });
});

describe('clampBox', () => {
  it('giữ nguyên hộp nằm trong khung', () => {
    expect(clampBox(box(10, 10, 20, 20), 640, 480)).toEqual(box(10, 10, 20, 20));
  });

  it('cắt hộp tràn khung và không sửa hộp gốc', () => {
    const original = box(-5, -5, 700, 500);
    expect(clampBox(original, 640, 480)).toEqual(box(0, 0, 640, 480));
    expect(original).toEqual(box(-5, -5, 700, 500));
  });

  it('hộp nằm hẳn ngoài khung ra hộp suy biến, không ném lỗi', () => {
    const result = clampBox(box(700, 0, 800, 10), 640, 480);
    expect(isValidBox(result)).toBe(false);
  });
});

describe('isValidBox', () => {
  it.each([
    { name: 'hộp thường', b: box(0, 0, 1, 1), expected: true },
    { name: 'rộng bằng 0', b: box(0, 0, 0, 1), expected: false },
    { name: 'đảo ngược', b: box(1, 1, 0, 0), expected: false },
    { name: 'chứa NaN', b: box(Number.NaN, 0, 1, 1), expected: false },
    { name: 'chứa vô cực', b: box(0, 0, Number.POSITIVE_INFINITY, 1), expected: false },
  ])('$name', ({ b, expected }) => {
    expect(isValidBox(b)).toBe(expected);
  });
});