import type { Detection, FrameAnalysis } from '../contracts';
import { iou, isValidBox } from '../utils/geometry';

/** Kết quả phát hiện xung đột lớp, đúng kiểu FrameAnalysis['conflict']. */
export type ConflictInfo = FrameAnalysis['conflict'];

/**
 * Phát hiện xung đột lớp: hai hộp gần như cùng một vật (IoU ≥ conflictIou) nhưng KHÁC mệnh giá,
 * nghĩa là mô hình đang phân vân giữa hai mệnh giá cho cùng một tờ tiền.
 * So sánh theo mệnh giá (denomination), không theo classId.
 * Hộp suy biến (không hợp lệ theo isValidBox) bị bỏ qua. Cùng mệnh giá thì không bao giờ là xung đột.
 *
 * @param detections Detection của khung hình, hộp theo pixel trong khung gốc.
 * @param conflictIou Ngưỡng IoU, không đơn vị trong [0, 1] (config.analyzer.conflictIou).
 * @returns detected: có cặp xung đột; pairs: cặp id (theo thứ tự đầu vào).
 */
export function detectClassConflict(detections: readonly Detection[], conflictIou: number): ConflictInfo {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < detections.length; i++) {
    const a = detections[i];
    if (a === undefined || !isValidBox(a.bbox)) continue;
    for (let j = i + 1; j < detections.length; j++) {
      const b = detections[j];
      if (b === undefined || !isValidBox(b.bbox)) continue;
      if (a.denomination === b.denomination) continue;
      if (iou(a.bbox, b.bbox) >= conflictIou) pairs.push([a.id, b.id]);
    }
  }
  return { detected: pairs.length > 0, pairs };
}