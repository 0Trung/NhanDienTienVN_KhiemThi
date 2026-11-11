import type { BBox } from '../contracts';
import { clamp } from './math';

/** Diện tích hộp. Hộp suy biến (rộng/cao ≤ 0, đảo ngược, NaN, vô cực) trả 0, không ném lỗi. */
export function area(b: BBox): number {
  const w = b.x2 - b.x1;
  const h = b.y2 - b.y1;
  if (!(w > 0) || !(h > 0)) return 0;
  const r = w * h;
  return Number.isFinite(r) ? r : 0;
}

/** Diện tích phần giao của hai hộp; rời nhau, chỉ chạm cạnh hoặc suy biến thì 0. */
export function intersectionArea(a: BBox, b: BBox): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (!(w > 0) || !(h > 0)) return 0;
  const r = w * h;
  return Number.isFinite(r) ? r : 0;
}

/** Intersection over Union, trong [0, 1]; suy biến thì 0. */
export function iou(a: BBox, b: BBox): number {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Diện tích giao chia cho diện tích hộp nhỏ hơn; hộp nhỏ nằm trọn trong hộp lớn thì 1. Suy biến thì 0. */
export function overlapOverMin(a: BBox, b: BBox): number {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const smaller = Math.min(area(a), area(b));
  return smaller > 0 ? inter / smaller : 0;
}

/** Tâm hộp. */
export function center(b: BBox): { x: number; y: number } {
  return { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
}

/** Cắt hộp vào khung [0, w] × [0, h]. Trả hộp mới, không sửa hộp gốc; có thể ra hộp suy biến. */
export function clampBox(b: BBox, w: number, h: number): BBox {
  const maxX = Number.isFinite(w) && w > 0 ? w : 0;
  const maxY = Number.isFinite(h) && h > 0 ? h : 0;
  return {
    x1: clamp(b.x1, 0, maxX),
    y1: clamp(b.y1, 0, maxY),
    x2: clamp(b.x2, 0, maxX),
    y2: clamp(b.y2, 0, maxY),
  };
}

/** Hộp hợp lệ: mọi toạ độ hữu hạn, x1 < x2 và y1 < y2. */
export function isValidBox(b: BBox): boolean {
  return (
    Number.isFinite(b.x1) && Number.isFinite(b.y1) && Number.isFinite(b.x2) && Number.isFinite(b.y2) &&
    b.x2 > b.x1 && b.y2 > b.y1
  );
}