import { describe, expect, it } from 'vitest';
import { clamp, mean, mulberry32 } from '../../src/utils/math';

describe('clamp', () => {
  it.each([
    { name: 'trong đoạn', v: 5, lo: 0, hi: 10, expected: 5 },
    { name: 'dưới đoạn', v: -3, lo: 0, hi: 10, expected: 0 },
    { name: 'trên đoạn', v: 42, lo: 0, hi: 10, expected: 10 },
    { name: 'đầu mút bị đảo', v: 5, lo: 10, hi: 0, expected: 5 },
    { name: 'NaN trả đầu mút dưới', v: Number.NaN, lo: 0, hi: 10, expected: 0 },
  ])('$name', ({ v, lo, hi, expected }) => {
    expect(clamp(v, lo, hi)).toBe(expected);
  });
});

describe('mean', () => {
  it('mảng rỗng trả 0', () => {
    expect(mean([])).toBe(0);
  });

  it('tính trung bình mảng thường', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it('nhận cả mảng định kiểu (ArrayLike)', () => {
    expect(mean(new Uint8Array([10, 20, 30]))).toBe(20);
  });
});

describe('mulberry32', () => {
  const take = (gen: () => number, n: number): number[] => Array.from({ length: n }, () => gen());

  it('cùng seed cho cùng dãy', () => {
    expect(take(mulberry32(42), 10)).toEqual(take(mulberry32(42), 10));
  });

  it('khác seed cho dãy khác', () => {
    expect(take(mulberry32(1), 10)).not.toEqual(take(mulberry32(2), 10));
  });

  it('mọi giá trị nằm trong [0, 1)', () => {
    for (const x of take(mulberry32(7), 1000)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});