// Tính bảng chỉ số mục 13.4 từ nhật ký thử nghiệm thật. Hàm thuần: nhận LogRow[], trả số liệu.
// Quy ước: "công bố" = dòng có announcedTotal; "có tiền" = noteCountTrue > 0; "không có tiền" = noteCountTrue = 0.
import { makeRate, meanOrNull, percentile } from '../shared/format';
import type { Rate } from '../shared/format';
import type { LogRow } from './parse-csv';

/** Phân vị dùng cho độ trễ đầu-cuối. */
const P50 = 50;
const P95 = 95;

export interface LatencyStats {
  /** Số lượt có latencyMs trong các lượt đã công bố. */
  samples: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
}

export interface LogMetrics {
  trials: number;
  moneyTrials: number;
  noMoneyTrials: number;
  /** Phát hiện có/không có tiền đúng: (noteCountDetected > 0) = (noteCountTrue > 0), trên các lượt có noteCountDetected. */
  detectionAccuracy: Rate;
  /** noteCountDetected = noteCountTrue, trên các lượt CÓ tiền và có noteCountDetected. */
  noteCountAccuracy: Rate;
  /**
   * ƯỚC LƯỢNG (cận trên) vì nhật ký không ghi từng mệnh giá: lượt có tiền, có noteCountDetected, đã công bố,
   * công bố đúng tổng VÀ đúng số tờ. Hai tập khác nhau vẫn có thể cùng tổng và cùng số tờ.
   */
  denominationSetAccuracy: Rate;
  /** Công bố đúng tổng / lượt có tiền (lượt bị từ chối tính là không đúng). */
  totalAccuracy: Rate;
  /** Công bố sai tổng (kể cả đọc khi không có tiền) / lượt đã công bố. */
  unsafeReadRate: Rate;
  /** Lượt không công bố / mọi lượt. */
  rejectionRate: Rate;
  /** Lượt không có tiền mà vẫn công bố / lượt không có tiền. */
  falsePositiveRate: Rate;
  latencyMs: LatencyStats;
  /** offlineVoiceOk = true / lượt có ghi offlineVoiceOk. */
  offlineVoiceSuccessRate: Rate;
}

const count = (rows: readonly LogRow[], predicate: (r: LogRow) => boolean): number => rows.filter(predicate).length;
const isPublished = (r: LogRow): boolean => r.announcedTotal !== null;
const isCorrectTotal = (r: LogRow): boolean => r.announcedTotal !== null && r.announcedTotal === r.groundTruthTotal;

/** Tính mọi chỉ số. Danh sách rỗng cho mọi tỷ lệ N/A (mẫu số 0), không ném lỗi. */
export function computeLogMetrics(rows: readonly LogRow[]): LogMetrics {
  const money = rows.filter((r) => r.noteCountTrue > 0);
  const noMoney = rows.filter((r) => r.noteCountTrue === 0);
  const published = rows.filter(isPublished);
  const withDetected = rows.filter((r) => r.noteCountDetected !== null);
  const moneyWithDetected = money.filter((r) => r.noteCountDetected !== null);
  const latencies = published.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]));
  const voiceRows = rows.filter((r) => r.offlineVoiceOk !== null);

  return {
    trials: rows.length,
    moneyTrials: money.length,
    noMoneyTrials: noMoney.length,
    detectionAccuracy: makeRate(
      count(withDetected, (r) => ((r.noteCountDetected ?? 0) > 0) === (r.noteCountTrue > 0)),
      withDetected.length,
    ),
    noteCountAccuracy: makeRate(count(moneyWithDetected, (r) => r.noteCountDetected === r.noteCountTrue), moneyWithDetected.length),
    denominationSetAccuracy: makeRate(
      count(moneyWithDetected, (r) => isCorrectTotal(r) && r.noteCountDetected === r.noteCountTrue),
      moneyWithDetected.length,
    ),
    totalAccuracy: makeRate(count(money, isCorrectTotal), money.length),
    unsafeReadRate: makeRate(count(published, (r) => !isCorrectTotal(r)), published.length),
    rejectionRate: makeRate(rows.length - published.length, rows.length),
    falsePositiveRate: makeRate(count(noMoney, isPublished), noMoney.length),
    latencyMs: { samples: latencies.length, mean: meanOrNull(latencies), p50: percentile(latencies, P50), p95: percentile(latencies, P95) },
    offlineVoiceSuccessRate: makeRate(count(voiceRows, (r) => r.offlineVoiceOk === true), voiceRows.length),
  };
}