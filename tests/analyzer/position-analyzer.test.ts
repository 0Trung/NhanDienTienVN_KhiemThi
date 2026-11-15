import { describe, expect, it } from 'vitest';
import { analyzePosition } from '../../src/analyzer/position-analyzer';
import type { BBox, Detection } from '../../src/contracts';
import { makeDetection } from '../fakes';

const MIN_AREA_RATIO = 0.04;
const EDGE_MARGIN_RATIO = 0.01;
const FRAME = { width: 640, height: 480 }; // biên mép = 0,01 × 480 = 4,8 px

const box = (x1: number, y1: number, x2: number, y2: number): BBox => ({ x1, y1, x2, y2 });
const det = (bbox: BBox, index = 0): Detection => makeDetection({ id: `1-${index}`, bbox });
const analyze = (detections: Detection[], frame = FRAME) =>
  analyzePosition(detections, frame, MIN_AREA_RATIO, EDGE_MARGIN_RATIO);

describe('analyzePosition · kích thước và vị trí cơ bản', () => {
  it.each([
    { name: 'hộp nhỏ nằm giữa khung', bbox: box(250, 190, 350, 290), tooSmall: true, partial: false },
    { name: 'hộp vừa nằm giữa khung', bbox: box(170, 140, 470, 340), tooSmall: false, partial: false },
    { name: 'hộp có tỷ lệ diện tích đúng bằng ngưỡng (nghiêm ngặt nên chưa nhỏ)', bbox: box(100, 100, 228, 196), tooSmall: false, partial: false },
    { name: 'hộp ngay dưới ngưỡng diện tích', bbox: box(100, 100, 227, 196), tooSmall: true, partial: false },
  ])('$name', ({ bbox, tooSmall, partial }) => {
    expect(analyze([det(bbox)])).toEqual({ tooSmall, partial });
  });
});

describe('analyzePosition · chạm mép', () => {
  it.each([
    { name: 'sát mép trái', bbox: box(0, 100, 300, 300), partial: true },
    { name: 'cách mép trái trong biên (4 px)', bbox: box(4, 100, 300, 300), partial: true },
    { name: 'cách mép trái ngoài biên (5 px)', bbox: box(5, 100, 300, 300), partial: false },
    { name: 'sát mép phải', bbox: box(300, 100, 640, 300), partial: true },
    { name: 'cách mép phải trong biên (4 px)', bbox: box(300, 100, 636, 300), partial: true },
    { name: 'cách mép phải ngoài biên (5 px)', bbox: box(300, 100, 635, 300), partial: false },
    { name: 'sát mép trên', bbox: box(100, 0, 400, 200), partial: true },
    { name: 'sát mép dưới', bbox: box(100, 200, 400, 480), partial: true },
    { name: 'cách mép dưới trong biên (4 px)', bbox: box(100, 200, 400, 476), partial: true },
    { name: 'cách mép dưới ngoài biên (5 px)', bbox: box(100, 200, 400, 475), partial: false },
    { name: 'hộp tràn ra ngoài khung', bbox: box(-20, 100, 300, 300), partial: true },
  ])('$name', ({ bbox, partial }) => {
    expect(analyze([det(bbox)]).partial).toBe(partial);
  });

  it('biên tính theo cạnh NGẮN của khung (khung 1000 × 200 thì biên 2 px)', () => {
    const wide = { width: 1000, height: 200 };
    expect(analyze([det(box(3, 50, 400, 150))], wide).partial).toBe(false);
    expect(analyze([det(box(2, 50, 400, 150))], wide).partial).toBe(true);
  });
});

describe('analyzePosition · nhiều hộp và trường hợp biên', () => {
  it('chỉ cần một hộp nhỏ là tooSmall, hộp còn lại ở giữa không che lấp', () => {
    const result = analyze([det(box(170, 140, 470, 340), 0), det(box(500, 200, 540, 240), 1)]);
    expect(result).toEqual({ tooSmall: true, partial: false });
  });

  it('chỉ cần một hộp chạm mép là partial', () => {
    const result = analyze([det(box(20, 100, 200, 300), 0), det(box(400, 100, 640, 300), 1)]);
    expect(result).toEqual({ tooSmall: false, partial: true });
  });

  it('không có detection thì cả hai đều false', () => {
    expect(analyze([])).toEqual({ tooSmall: false, partial: false });
  });

  it('hộp suy biến có diện tích 0 nên tính là nhỏ', () => {
    expect(analyze([det(box(200, 200, 200, 300))]).tooSmall).toBe(true);
  });

  it.each([
    { name: 'chiều rộng 0', frame: { width: 0, height: 480 } },
    { name: 'chiều cao âm', frame: { width: 640, height: -1 } },
    { name: 'kích thước NaN', frame: { width: Number.NaN, height: 480 } },
  ])('khung không hợp lệ ($name) mà có detection thì Fail Safe: cả hai true', ({ frame }) => {
    expect(analyze([det(box(170, 140, 470, 340))], frame)).toEqual({ tooSmall: true, partial: true });
  });

  it('khung không hợp lệ nhưng không có detection thì cả hai false', () => {
    expect(analyze([], { width: 0, height: 0 })).toEqual({ tooSmall: false, partial: false });
  });

  it('không đột biến đầu vào đóng băng', () => {
    const input = Object.freeze([Object.freeze(det(Object.freeze(box(0, 0, 100, 100))))]);
    const snapshot = JSON.stringify(input);
    expect(() => analyze(input as Detection[])).not.toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});