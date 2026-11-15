import { describe, expect, it } from 'vitest';
import { measureBrightness } from '../../src/analyzer/brightness-analyzer';
import type { GrayImage } from '../../src/contracts';
import { makeGray } from '../fakes';

const LOW_LIGHT_MEAN = 60;

describe('measureBrightness · phân loại', () => {
  it.each([
    { name: 'ảnh đen hoàn toàn', gray: makeGray(8, 8, 0), brightness: 0, lowLight: true },
    { name: 'ảnh tối', gray: makeGray(8, 8, 20), brightness: 20, lowLight: true },
    { name: 'ngay dưới ngưỡng', gray: makeGray(8, 8, 59), brightness: 59, lowLight: true },
    { name: 'đúng ngưỡng (nghiêm ngặt nên chưa tối)', gray: makeGray(8, 8, 60), brightness: 60, lowLight: false },
    { name: 'ảnh vừa', gray: makeGray(8, 8, 128), brightness: 128, lowLight: false },
    { name: 'ảnh sáng', gray: makeGray(8, 8, 220), brightness: 220, lowLight: false },
    { name: 'ảnh trắng hoàn toàn', gray: makeGray(8, 8, 255), brightness: 255, lowLight: false },
  ])('$name', ({ gray, brightness, lowLight }) => {
    expect(measureBrightness(gray, LOW_LIGHT_MEAN)).toEqual({ brightness, lowLight });
  });
});

describe('measureBrightness · giá trị trung bình', () => {
  it('trung bình cộng mọi điểm ảnh', () => {
    const gray: GrayImage = { data: new Uint8Array([0, 0, 100, 100]), width: 2, height: 2 };
    expect(measureBrightness(gray, LOW_LIGHT_MEAN).brightness).toBe(50);
  });

  it('nửa đen nửa trắng cho độ sáng giữa thang', () => {
    const data = new Uint8Array(100);
    data.fill(255, 50);
    const result = measureBrightness({ data, width: 10, height: 10 }, LOW_LIGHT_MEAN);
    expect(result.brightness).toBeCloseTo(127.5, 9);
    expect(result.lowLight).toBe(false);
  });

  it('ngưỡng lấy từ tham số: cùng ảnh, ngưỡng cao hơn thì thành thiếu sáng', () => {
    const gray = makeGray(8, 8, 100);
    expect(measureBrightness(gray, 60).lowLight).toBe(false);
    expect(measureBrightness(gray, 150).lowLight).toBe(true);
  });

  it('ảnh rỗng cho brightness 0 và lowLight true (không đo được thì coi là tối)', () => {
    const gray: GrayImage = { data: new Uint8Array(0), width: 0, height: 0 };
    expect(measureBrightness(gray, LOW_LIGHT_MEAN)).toEqual({ brightness: 0, lowLight: true });
  });

  it('không sửa dữ liệu ảnh đầu vào', () => {
    const gray = makeGray(8, 8, 90);
    const before = Array.from(gray.data);
    measureBrightness(gray, LOW_LIGHT_MEAN);
    expect(Array.from(gray.data)).toEqual(before);
  });
});