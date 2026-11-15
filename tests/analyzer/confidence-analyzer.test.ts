import { describe, expect, it } from 'vitest';
import { splitByConfidence } from '../../src/analyzer/confidence-analyzer';
import type { Detection } from '../../src/contracts';
import { makeDetection } from '../fakes';

const CONF_LOW = 0.25;
const CONF_SURE = 0.7;

const det = (index: number, confidence: number): Detection =>
  makeDetection({ id: `1-${index}`, confidence, bbox: { x1: index * 100, y1: 100, x2: index * 100 + 80, y2: 300 } });

describe('splitByConfidence · phân loại theo ngưỡng', () => {
  it.each([
    { name: 'đúng ranh confLow thì chưa chắc', confidence: 0.25, bucket: 'unsure' },
    { name: 'ngay dưới confLow thì bị loại', confidence: 0.2499, bucket: 'none' },
    { name: 'ngay dưới confSure thì chưa chắc', confidence: 0.6999, bucket: 'unsure' },
    { name: 'đúng ranh confSure thì chắc', confidence: 0.7, bucket: 'sure' },
    { name: 'độ tin cậy 1 thì chắc', confidence: 1, bucket: 'sure' },
    { name: 'độ tin cậy 0 thì bị loại', confidence: 0, bucket: 'none' },
    { name: 'NaN thì bị loại', confidence: Number.NaN, bucket: 'none' },
  ])('$name', ({ confidence, bucket }) => {
    const d = det(0, confidence);
    const result = splitByConfidence([d], CONF_LOW, CONF_SURE);
    expect(result.sure).toEqual(bucket === 'sure' ? [d] : []);
    expect(result.unsure).toEqual(bucket === 'unsure' ? [d] : []);
    expect(result.kept).toEqual(bucket === 'none' ? [] : [d]);
  });
});

describe('splitByConfidence · thứ tự và tham chiếu', () => {
  it('giữ nguyên thứ tự đầu vào trong từng mảng', () => {
    const input = [det(0, 0.9), det(1, 0.4), det(2, 0.8), det(3, 0.3), det(4, 0.1)];
    const result = splitByConfidence(input, CONF_LOW, CONF_SURE);
    expect(result.sure.map((d) => d.id)).toEqual(['1-0', '1-2']);
    expect(result.unsure.map((d) => d.id)).toEqual(['1-1', '1-3']);
    expect(result.kept.map((d) => d.id)).toEqual(['1-0', '1-1', '1-2', '1-3']);
  });

  it('trả chính đối tượng đầu vào, không sao chép', () => {
    const d = det(0, 0.9);
    expect(splitByConfidence([d], CONF_LOW, CONF_SURE).sure[0]).toBe(d);
  });

  it('danh sách rỗng cho ba mảng rỗng', () => {
    expect(splitByConfidence([], CONF_LOW, CONF_SURE)).toEqual({ sure: [], unsure: [], kept: [] });
  });
});

describe('splitByConfidence · không đột biến đầu vào', () => {
  it('đầu vào đóng băng vẫn chạy được và không đổi', () => {
    const input = Object.freeze([Object.freeze(det(0, 0.9)), Object.freeze(det(1, 0.4))]);
    const snapshot = JSON.stringify(input);
    expect(() => splitByConfidence(input, CONF_LOW, CONF_SURE)).not.toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});