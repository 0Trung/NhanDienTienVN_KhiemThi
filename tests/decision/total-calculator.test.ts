import { describe, expect, it } from 'vitest';
import { DENOMINATIONS } from '../../src/contracts';
import type { Denomination } from '../../src/contracts';
import { formatVND } from '../../src/config/denominations';
import { calculateTotal } from '../../src/decision/total-calculator';
import { mulberry32 } from '../../src/utils/math';

describe('calculateTotal', () => {
  it.each<{ name: string; input: Denomination[]; total: number; formatted: string }>([
    { name: 'ba tờ khác mệnh giá', input: [20000, 50000, 100000], total: 170000, formatted: '170.000 đồng' },
    { name: 'hai tờ cùng mệnh giá', input: [10000, 10000], total: 20000, formatted: '20.000 đồng' },
    { name: 'một tờ nhỏ nhất', input: [1000], total: 1000, formatted: '1.000 đồng' },
    { name: 'tổng vượt một triệu', input: [500000, 500000, 200000, 200000, 100000], total: 1500000, formatted: '1.500.000 đồng' },
    { name: 'đủ 9 mệnh giá', input: [...DENOMINATIONS], total: 888000, formatted: '888.000 đồng' },
  ])('$name', ({ input, total, formatted }) => {
    expect(calculateTotal(input)).toEqual({ count: input.length, denominations: input, total, formattedTotal: formatted });
  });

  it('giữ nguyên thứ tự, trả bản sao và không sửa mảng đầu vào', () => {
    const input = Object.freeze<Denomination[]>([500000, 1000, 20000, 1000]) as Denomination[];
    const result = calculateTotal(input);
    expect(result.denominations).toEqual([500000, 1000, 20000, 1000]);
    expect(result.denominations).not.toBe(input);
  });

  it.each<{ name: string; input: unknown[] }>([
    { name: 'danh sách rỗng', input: [] },
    { name: 'mệnh giá không tồn tại', input: [15000] },
    { name: 'số 0', input: [0] },
    { name: 'số âm', input: [-20000] },
    { name: 'NaN', input: [Number.NaN] },
    { name: 'vô cực', input: [Number.POSITIVE_INFINITY] },
    { name: 'số lẻ', input: [1000.5] },
    { name: 'chuỗi số', input: ['20000'] },
    { name: 'null', input: [null] },
    { name: 'một giá trị lạ lẫn giữa các giá trị hợp lệ', input: [20000, 30000, 50000] },
  ])('ném RangeError: $name', ({ input }) => {
    expect(() => calculateTotal(input as Denomination[])).toThrow(RangeError);
  });

  it('300 danh sách ngẫu nhiên: tổng, số tờ, thứ tự và định dạng đều khớp', () => {
    const random = mulberry32(20241114);
    for (let i = 0; i < 300; i++) {
      const input = Array.from({ length: 1 + Math.floor(random() * 8) }, () => DENOMINATIONS[Math.floor(random() * DENOMINATIONS.length)] as Denomination);
      const sum = input.reduce((acc, d) => acc + d, 0);
      expect(calculateTotal(input)).toEqual({ count: input.length, denominations: input, total: sum, formattedTotal: formatVND(sum) });
    }
  });
});