import type { Detection, FrameAnalysis, FrameMeta } from '../contracts';
import { area } from '../utils/geometry';

/** Kết quả phân tích vị trí, đúng kiểu FrameAnalysis['position']. */
export type PositionInfo = FrameAnalysis['position'];

/**
 * Mô tả vị trí các tờ tiền so với khung hình.
 * - tooSmall: có ít nhất một hộp với (diện tích hộp / diện tích khung) < minAreaRatio. Hộp suy biến có diện tích 0 nên tính là nhỏ.
 * - partial: có ít nhất một hộp chạm mép khung, tức mép hộp cách mép khung không quá
 *   edgeMarginRatio × cạnh NGẮN của khung (biên tính bằng pixel, so sánh bao gồm đúng ranh).
 *   Hộp tràn ra ngoài khung cũng tính là chạm mép.
 * - Không có detection nào: cả hai đều false.
 * - Kích thước khung không hợp lệ (không hữu hạn hoặc ≤ 0) mà có detection: không kiểm chứng được hộp
 *   có đủ lớn và nằm trọn trong khung, nên theo nguyên tắc Fail Safe trả cả hai true.
 *
 * @param detections Detection của khung hình, hộp theo pixel trong khung gốc.
 * @param frame Kích thước khung gốc, pixel (FrameMeta.width, FrameMeta.height).
 * @param minAreaRatio Tỷ lệ diện tích tối thiểu, không đơn vị (config.analyzer.minAreaRatio).
 * @param edgeMarginRatio Biên mép, tỷ lệ của cạnh ngắn khung, không đơn vị (config.analyzer.edgeMarginRatio).
 */
export function analyzePosition(
  detections: readonly Detection[],
  frame: Pick<FrameMeta, 'width' | 'height'>,
  minAreaRatio: number,
  edgeMarginRatio: number,
): PositionInfo {
  if (detections.length === 0) return { tooSmall: false, partial: false };

  const { width, height } = frame;
  const frameArea = width * height;
  if (!Number.isFinite(frameArea) || !(width > 0) || !(height > 0)) {
    return { tooSmall: true, partial: true };
  }

  const marginPx = edgeMarginRatio * Math.min(width, height);
  let tooSmall = false;
  let partial = false;
  for (const { bbox } of detections) {
    if (area(bbox) / frameArea < minAreaRatio) tooSmall = true;
    if (bbox.x1 <= marginPx || bbox.y1 <= marginPx || bbox.x2 >= width - marginPx || bbox.y2 >= height - marginPx) {
      partial = true;
    }
  }
  return { tooSmall, partial };
}