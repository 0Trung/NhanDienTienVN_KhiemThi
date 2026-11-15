import type { AppConfig, Detection, FrameAnalysis, IFrameAnalyzer, InferenceResult } from '../contracts';
import { center } from '../utils/geometry';
import { measureBlur } from './blur-detector';
import { measureBrightness } from './brightness-analyzer';
import { splitByConfidence } from './confidence-analyzer';
import { detectClassConflict } from './conflict-detector';
import { detectOverlap } from './overlap-detector';
import { analyzePosition } from './position-analyzer';
import { createTemporalStabilizer, isFrameValid } from './temporal-stabilizer';

/** Sắp từ trái sang phải (tâm x tăng dần, hòa thì theo tâm y), ổn định. Trả mảng mới, không sửa đầu vào. */
function sortLeftToRight(detections: readonly Detection[]): Detection[] {
  return [...detections].sort((a, b) => {
    const ca = center(a.bbox);
    const cb = center(b.bbox);
    return ca.x - cb.x || ca.y - cb.y;
  });
}

/**
 * Tạo bộ phân tích khung hình. Chỉ MÔ TẢ khung hình (chắc hay không, chồng lấn, xung đột, vị trí, mờ, tối, ổn định),
 * tuyệt đối không quyết định đọc hay không, không nói, không tính tổng.
 *
 * Mỗi lần analyze: sắp detection trái → phải, tách sure/unsure (A1), rồi chạy A2 đến A6 trên mọi detection có
 * độ tin cậy ≥ confLow (cả chắc lẫn chưa chắc), cuối cùng đưa khung vào bộ ổn định (A7).
 * Ngưỡng: confLow, confSure lấy từ config.inference; mọi ngưỡng còn lại từ config.analyzer. Không có hằng số ma thuật.
 * Trạng thái duy nhất giữ lại giữa các khung: cửa sổ của bộ ổn định và emptyStreak.
 * Không sửa InferenceResult đầu vào; kết quả dùng mảng mới (các đối tượng Detection được dùng chung với đầu vào).
 * Ném RangeError nếu config.analyzer.stabilizer không hợp lệ (xem createTemporalStabilizer).
 *
 * @param config Cấu hình ứng dụng (DEFAULT_CONFIG hoặc bản đã hiệu chỉnh).
 */
export function createFrameAnalyzer(config: AppConfig): IFrameAnalyzer {
  const { inference, analyzer } = config;
  const stabilizer = createTemporalStabilizer(analyzer.stabilizer);
  let emptyStreak = 0;

  /** Phân tích một kết quả suy luận; meta.timestamp (mili-giây) là mốc thời gian cho cửa sổ ổn định. */
  function analyze(r: InferenceResult): FrameAnalysis {
    const { sure, unsure, kept } = splitByConfidence(sortLeftToRight(r.detections), inference.confLow, inference.confSure);
    const overlap = detectOverlap(kept, analyzer.overlapRatio);
    const conflict = detectClassConflict(kept, analyzer.conflictIou);
    const position = analyzePosition(kept, r.meta, analyzer.minAreaRatio, analyzer.edgeMarginRatio);
    const blur = measureBlur(r.gray, r.meta, kept.map((d) => d.bbox), analyzer.blurThreshold);
    const brightness = measureBrightness(r.gray, analyzer.lowLightMean);

    const stability = stabilizer.push({
      timestamp: r.meta.timestamp,
      valid: isFrameValid({ sure, unsure, overlap, conflict }),
      sure,
    });
    emptyStreak = kept.length === 0 ? emptyStreak + 1 : 0;

    return {
      meta: { ...r.meta },
      detections: kept,
      sure,
      unsure,
      overlap,
      conflict,
      position,
      quality: { ...blur, ...brightness },
      stability,
      emptyStreak,
    };
  }

  /** Xóa cửa sổ ổn định và đưa emptyStreak về 0 (ví dụ khi camera tạm dừng rồi chạy lại). */
  function reset(): void {
    stabilizer.reset();
    emptyStreak = 0;
  }

  return { analyze, reset };
}