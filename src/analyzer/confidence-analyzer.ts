import type { Detection } from '../contracts';

/**
 * Kết quả tách detection theo độ tin cậy.
 * Cả ba mảng giữ NGUYÊN THỨ TỰ của đầu vào (trái → phải) và chứa chính các đối tượng Detection đầu vào (không sao chép).
 */
export interface ConfidenceSplit {
  /** Độ tin cậy ≥ confSure. */
  sure: Detection[];
  /** confLow ≤ độ tin cậy < confSure. */
  unsure: Detection[];
  /** Hợp của sure và unsure, tức mọi detection có độ tin cậy ≥ confLow, theo đúng thứ tự đầu vào. */
  kept: Detection[];
}

/**
 * Tách detection thành "chắc" và "chưa chắc".
 * - confidence ≥ confSure → sure (đúng ranh thì tính là chắc).
 * - confLow ≤ confidence < confSure → unsure (đúng ranh confLow thì còn giữ).
 * - confidence < confLow hoặc NaN → bị loại khỏi cả ba mảng (so sánh với NaN luôn sai nên thà loại còn hơn tin).
 * Hàm thuần, không sửa đầu vào.
 * @param detections Danh sách detection của một khung hình.
 * @param confLow Ngưỡng thấp nhất còn xét, độ tin cậy không đơn vị trong [0, 1] (config.inference.confLow).
 * @param confSure Ngưỡng đủ chắc, độ tin cậy không đơn vị trong [0, 1] (config.inference.confSure).
 */
export function splitByConfidence(
  detections: readonly Detection[],
  confLow: number,
  confSure: number,
): ConfidenceSplit {
  const sure: Detection[] = [];
  const unsure: Detection[] = [];
  const kept: Detection[] = [];
  for (const d of detections) {
    if (d.confidence >= confSure) {
      sure.push(d);
      kept.push(d);
    } else if (d.confidence >= confLow) {
      unsure.push(d);
      kept.push(d);
    }
  }
  return { sure, unsure, kept };
}