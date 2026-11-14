import type { BBox } from '../contracts';
import { iou } from '../utils/geometry';

export interface NmsOptions {
  /** Loại hộp có IoU LỚN HƠN ngưỡng này với một hộp đã giữ (so sánh nghiêm ngặt). */
  iouThreshold: number;
  /** true: gộp mọi lớp (agnostic); false: chỉ so các hộp cùng lớp (class-aware). */
  agnostic: boolean;
  /** Dừng khi đã giữ đủ số hộp này. */
  maxDetections: number;
}

/**
 * F4: NMS tham lam. Điều kiện đầu vào: ứng viên [0, count) đã sắp theo điểm GIẢM DẦN.
 * Mỗi ứng viên chỉ được so với các hộp ĐÃ GIỮ (tối đa maxDetections), không so với hộp đã bị loại,
 * nên chi phí là O(count × maxDetections), không có vòng lặp O(N²) trên toàn bộ anchor.
 * Ghi chỉ số ứng viên được giữ vào `kept` (theo thứ tự điểm giảm dần) và trả về số hộp giữ.
 * `kept` phải đủ chỗ cho min(count, maxDetections) phần tử.
 */
export function greedyNms(
  boxes: readonly BBox[],
  classIds: ArrayLike<number>,
  count: number,
  opts: NmsOptions,
  kept: Int32Array,
): number {
  const limit = Math.min(opts.maxDetections, count, kept.length);
  let keptCount = 0;
  for (let r = 0; r < count && keptCount < limit; r++) {
    const box = boxes[r];
    if (box === undefined) continue;
    const classId = classIds[r];
    let suppressed = false;
    for (let k = 0; k < keptCount; k++) {
      const other = kept[k] ?? 0;
      if (!opts.agnostic && classIds[other] !== classId) continue;
      const otherBox = boxes[other];
      if (otherBox !== undefined && iou(box, otherBox) > opts.iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) {
      kept[keptCount] = r;
      keptCount++;
    }
  }
  return keptCount;
}