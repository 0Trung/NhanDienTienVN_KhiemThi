import { describe, expect, it } from 'vitest';
import { formatDecimal, formatMs, formatOptional, formatRate, makeRate, meanOrNull, percentile, renderTable } from '../../tools/shared/format';

describe('percentile (hạng gần nhất)', () => {
  const oneToTwenty = Array.from({ length: 20 }, (_, i) => i + 1);

  it.each([
    { values: [1, 2, 3, 4], p: 50, expected: 2 },
    { values: [4, 1, 3, 2], p: 50, expected: 2 },
    { values: oneToTwenty, p: 95, expected: 19 },
    { values: oneToTwenty, p: 100, expected: 20 },
    { values: oneToTwenty, p: 0, expected: 1 },
    { values: [700], p: 95, expected: 700 },
    { values: [], p: 50, expected: null },
  ])('p$p của $values.length phần tử = $expected', ({ values, p, expected }) => {
    expect(percentile(values, p)).toBe(expected);
  });

  it.each([-1, 100.5, Number.NaN])('p = %s bị từ chối bằng RangeError', (p) => {
    expect(() => percentile([1, 2, 3], p)).toThrow(RangeError);
  });

  it('không sửa mảng đầu vào', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('makeRate và formatRate', () => {
  it.each([
    { n: 1, d: 2, value: 0.5, text: '50,0% (1/2)' },
    { n: 0, d: 9000, value: 0, text: '0,0% (0/9000)' },
    { n: 2, d: 3, value: 2 / 3, text: '66,7% (2/3)' },
    { n: 0, d: 0, value: null, text: 'N/A (0/0)' },
  ])('$n/$d', ({ n, d, value, text }) => {
    const rate = makeRate(n, d);
    expect(rate).toEqual({ numerator: n, denominator: d, value });
    expect(formatRate(rate)).toBe(text);
  });
});

describe('định dạng số', () => {
  it('số thập phân dùng dấu phẩy', () => {
    expect(formatDecimal(1.25, 1)).toBe('1,3');
    expect(formatDecimal(4, 1)).toBe('4,0');
  });

  it('thời gian kèm đơn vị, null thì N/A', () => {
    expect(formatMs(999)).toBe('999 ms');
    expect(formatMs(null)).toBe('N/A');
    expect(formatOptional(null, 1)).toBe('N/A');
    expect(formatOptional(4, 1)).toBe('4,0');
  });

  it('meanOrNull: mảng rỗng là null chứ không phải 0', () => {
    expect(meanOrNull([])).toBeNull();
    expect(meanOrNull([1, 2, 6])).toBe(3);
  });
});

describe('renderTable', () => {
  it('dựng bảng markdown có dòng phân cách', () => {
    expect(renderTable(['A', 'B'], [['1', '2']])).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('thoát dấu | và bỏ xuống dòng trong ô', () => {
    expect(renderTable(['A'], [['x|y\nz']])).toBe('| A |\n| --- |\n| x\\|y z |');
  });

  it('hàng lệch số cột bị từ chối bằng RangeError', () => {
    expect(() => renderTable(['A', 'B'], [['1']])).toThrow(RangeError);
  });
});