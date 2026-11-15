import { describe, expect, it } from 'vitest';
import { detectClassConflict } from '../../src/analyzer/conflict-detector';
import type { BBox, Denomination, Detection } from '../../src/contracts';
import { makeDetection } from '../fakes';

const CONFLICT_IOU = 0.5;

const box = (x1: number, y1: number, x2: number, y2: number): BBox => ({ x1, y1, x2, y2 });
const det = (id: string, denomination: Denomination, bbox: BBox): Detection =>
  makeDetection({ id, denomination, bbox });

/** Hộp gốc 100 × 100 ở (0, 0). Hộp (0, 0, 100, h) có IoU với hộp gốc đúng bằng h / 100. */
const BASE = box(0, 0, 100, 100);
const withIou = (iouValue: number): BBox => box(0, 0, 100, 100 * iouValue);

describe('detectClassConflict · hai hộp', () => {
  it.each([
    { name: 'cùng lớp, IoU 0,6 thì không xung đột', second: 20000 as Denomination, other: withIou(0.6), detected: false },
    { name: 'cùng lớp, hộp trùng khít thì không xung đột', second: 20000 as Denomination, other: box(0, 0, 100, 100), detected: false },
    { name: 'khác lớp, IoU 0,6 thì xung đột', second: 50000 as Denomination, other: withIou(0.6), detected: true },
    { name: 'khác lớp, hộp trùng khít thì xung đột', second: 50000 as Denomination, other: box(0, 0, 100, 100), detected: true },
    { name: 'khác lớp, đúng ngưỡng IoU 0,5 thì xung đột (so sánh ≥)', second: 50000 as Denomination, other: withIou(0.5), detected: true },
    { name: 'khác lớp, IoU 0,3 thì không xung đột', second: 50000 as Denomination, other: withIou(0.3), detected: false },
    { name: 'khác lớp, rời nhau thì không xung đột', second: 50000 as Denomination, other: box(300, 0, 400, 100), detected: false },
  ])('$name', ({ second, other, detected }) => {
    const result = detectClassConflict([det('a', 20000, BASE), det('b', second, other)], CONFLICT_IOU);
    expect(result.detected).toBe(detected);
    expect(result.pairs).toEqual(detected ? [['a', 'b']] : []);
  });
});

describe('detectClassConflict · hộp suy biến', () => {
  it.each([
    { name: 'rộng bằng 0', bad: box(0, 0, 0, 100) },
    { name: 'đảo ngược', bad: box(100, 100, 0, 0) },
    { name: 'chứa NaN', bad: box(0, Number.NaN, 100, 100) },
  ])('$name bị bỏ qua', ({ bad }) => {
    const result = detectClassConflict([det('a', 20000, BASE), det('bad', 50000, bad)], CONFLICT_IOU);
    expect(result).toEqual({ detected: false, pairs: [] });
  });
});

describe('detectClassConflict · nhiều hộp', () => {
  it('ba hộp cùng chỗ: chỉ các cặp khác mệnh giá là xung đột', () => {
    const result = detectClassConflict(
      [det('a', 20000, BASE), det('b', 50000, BASE), det('c', 20000, BASE)],
      CONFLICT_IOU,
    );
    expect(result.pairs).toEqual([['a', 'b'], ['b', 'c']]);
  });

  it.each([
    { name: 'không có hộp nào', input: [] as Detection[] },
    { name: 'chỉ một hộp', input: [det('a', 20000, BASE)] },
  ])('$name thì không xung đột', ({ input }) => {
    expect(detectClassConflict(input, CONFLICT_IOU)).toEqual({ detected: false, pairs: [] });
  });
});

describe('detectClassConflict · không đột biến đầu vào', () => {
  it('đầu vào đóng băng vẫn chạy được và không đổi', () => {
    const input = Object.freeze([
      Object.freeze(det('a', 20000, Object.freeze(box(0, 0, 100, 100)))),
      Object.freeze(det('b', 50000, Object.freeze(box(0, 0, 100, 60)))),
    ]);
    const snapshot = JSON.stringify(input);
    expect(() => detectClassConflict(input, CONFLICT_IOU)).not.toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});