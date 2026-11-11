import { describe, expect, it } from 'vitest';
import { AppError, DENOMINATIONS } from '../../src/contracts';
import type { ClassesJson } from '../../src/contracts';
import { buildClassMap, formatVND, isDenomination } from '../../src/config/denominations';

/** Thứ tự ID cố tình xáo trộn: không được giả định ID tăng theo mệnh giá. */
const VALID: ClassesJson = {
  '0': 20000, '1': 500000, '2': 1000, '3': 100000, '4': 5000,
  '5': 50000, '6': 2000, '7': 200000, '8': 10000,
};

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('formatVND', () => {
  it.each([
    { n: 0, expected: '0 đồng' },
    { n: 1000, expected: '1.000 đồng' },
    { n: 20000, expected: '20.000 đồng' },
    { n: 170000, expected: '170.000 đồng' },
    { n: 1250000, expected: '1.250.000 đồng' },
    { n: 500000, expected: '500.000 đồng' },
    { n: -5000, expected: '-5.000 đồng' },
  ])('$n → $expected', ({ n, expected }) => {
    expect(formatVND(n)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('%s ném RangeError', (n) => {
    expect(() => formatVND(n)).toThrow(RangeError);
  });
});

describe('isDenomination', () => {
  it.each([
    { n: 1000, expected: true },
    { n: 500000, expected: true },
    { n: 30000, expected: false },
    { n: 0, expected: false },
  ])('$n → $expected', ({ n, expected }) => {
    expect(isDenomination(n)).toBe(expected);
  });
});

describe('buildClassMap', () => {
  it('đủ 9 lớp: tra đúng theo classId, không theo thứ tự mệnh giá', () => {
    const map = buildClassMap(VALID);
    expect(map).toHaveLength(9);
    expect(map[0]).toBe(20000);
    expect(map[1]).toBe(500000);
    expect(map[8]).toBe(10000);
    expect([...map].sort((a, b) => a - b)).toEqual([...DENOMINATIONS]);
  });

  const { '8': _dropped, ...missingOne } = VALID;

  it.each([
    { name: 'thiếu 1 lớp', classes: missingOne as ClassesJson },
    { name: 'trùng mệnh giá', classes: { ...VALID, '8': 20000 } as ClassesJson },
    { name: 'giá trị ngoài danh sách', classes: { ...VALID, '8': 30000 } as unknown as ClassesJson },
    { name: 'giá trị không phải số', classes: { ...VALID, '8': '10000' } as unknown as ClassesJson },
    { name: 'classId không liên tục', classes: { ...missingOne, '9': 10000 } as ClassesJson },
    { name: 'classId không phải số', classes: { ...missingOne, abc: 10000 } as unknown as ClassesJson },
    { name: 'classId có số 0 đứng đầu', classes: { ...missingOne, '08': 10000 } as unknown as ClassesJson },
  ])('$name → ném AppError MODEL_CORRUPT', ({ classes }) => {
    const err = caught(() => buildClassMap(classes));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('MODEL_CORRUPT');
  });
});