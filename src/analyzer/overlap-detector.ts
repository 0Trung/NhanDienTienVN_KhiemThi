import type { Detection, FrameAnalysis } from '../contracts';
import { isValidBox, overlapOverMin } from '../utils/geometry';

/** Kết quả phát hiện chồng lấn, đúng kiểu FrameAnalysis['overlap']. */
export type OverlapInfo = FrameAnalysis['overlap'];

/**
 * Phát hiện các tờ tiền chồng lên nhau.
 *
 * Với mọi cặp hộp: ratio = diện tích giao / diện tích hộp NHỎ HƠN (overlapOverMin, không đơn vị, trong [0, 1]).
 * Cặp có ratio > overlapRatio (so sánh nghiêm ngặt) là chồng lấn.
 * Hộp suy biến (không hợp lệ theo isValidBox) bị bỏ qua hoàn toàn, không tạo cặp nào.
 *
 * LƯU Ý HIỆU CHỈNH: hai tờ đặt NGHIÊNG cạnh nhau có hộp bao (hộp song song với trục ảnh)
 * có thể chồng nhau dù hai tờ thật không chồng. Vì vậy ngưỡng overlapRatio phải được
 * hiệu chỉnh bằng ảnh thật trên điện thoại, không tin giá trị mặc định.
 *
 * @param detections Detection của khung hình, hộp theo pixel trong khung gốc.
 * @param overlapRatio Ngưỡng chồng lấn, không đơn vị (config.analyzer.overlapRatio).
 * @returns detected: có cặp chồng lấn; maxRatio: ratio lớn nhất trong mọi cặp hợp lệ (0 nếu không có cặp);
 *          pairs: cặp id (theo thứ tự đầu vào) có ratio > overlapRatio.
 */
export function detectOverlap(detections: readonly Detection[], overlapRatio: number): OverlapInfo {
  const pairs: Array<[string, string]> = [];
  let maxRatio = 0;
  for (let i = 0; i < detections.length; i++) {
    const a = detections[i];
    if (a === undefined || !isValidBox(a.bbox)) continue;
    for (let j = i + 1; j < detections.length; j++) {
      const b = detections[j];
      if (b === undefined || !isValidBox(b.bbox)) continue;
      const ratio = overlapOverMin(a.bbox, b.bbox);
      if (ratio > maxRatio) maxRatio = ratio;
      if (ratio > overlapRatio) pairs.push([a.id, b.id]);
    }
  }
  return { detected: pairs.length > 0, maxRatio, pairs };
}