// Dựng bảng markdown mục 13.4 và nội dung report.json từ LogMetrics. Hàm thuần.
import { formatMs, formatRate, renderTable } from '../shared/format';
import type { Rate } from '../shared/format';
import type { LogMetrics } from './metrics';

/** Nhãn phiên bản của cấu trúc report.json, để công cụ đọc sau này nhận ra định dạng. */
export const REPORT_SCHEMA = 'cdio4-trial-metrics/1';

/** Cấu trúc ghi vào report.json: mọi tỷ lệ kèm tử số, mẫu số; "value" là null khi không đo được. */
export interface TrialReport {
  schema: typeof REPORT_SCHEMA;
  source: string;
  metrics: LogMetrics;
}

export function buildReport(source: string, metrics: LogMetrics): TrialReport {
  return { schema: REPORT_SCHEMA, source, metrics };
}

const rateRow = (name: string, rate: Rate, how: string): string[] => [name, formatRate(rate), how];

/** Bảng chỉ số mục 13.4 bằng markdown, kèm cột "Cách tính" để người đọc biết mẫu số. */
export function renderMetricsTable(source: string, m: LogMetrics): string {
  const table = renderTable(['Chỉ số', 'Kết quả', 'Cách tính'], [
    rateRow('Detection Accuracy', m.detectionAccuracy, 'phát hiện đúng có/không có tiền, trên lượt có noteCountDetected'),
    rateRow('Note Count Accuracy', m.noteCountAccuracy, 'noteCountDetected = noteCountTrue, trên lượt có tiền'),
    rateRow('Denomination Set Accuracy (ước lượng)', m.denominationSetAccuracy, 'đúng cả tổng lẫn số tờ; nhật ký không ghi từng mệnh giá nên đây là cận trên'),
    rateRow('Total Accuracy', m.totalAccuracy, 'công bố đúng tổng, trên lượt có tiền (từ chối tính là chưa đúng)'),
    rateRow('Unsafe Read Rate', m.unsafeReadRate, 'công bố sai tổng, trên lượt đã công bố; mục tiêu = 0'),
    rateRow('Rejection Rate', m.rejectionRate, 'lượt không công bố, trên mọi lượt'),
    rateRow('False Positive Rate', m.falsePositiveRate, 'lượt KHÔNG có tiền mà vẫn công bố, trên lượt không có tiền'),
    ['End-to-End Latency (trung bình)', formatMs(m.latencyMs.mean), `trên ${m.latencyMs.samples} lượt đã công bố có latencyMs`],
    ['End-to-End Latency (p50)', formatMs(m.latencyMs.p50), 'phân vị hạng gần nhất'],
    ['End-to-End Latency (p95)', formatMs(m.latencyMs.p95), 'phân vị hạng gần nhất'],
    rateRow('Offline Voice Success Rate', m.offlineVoiceSuccessRate, 'offlineVoiceOk = true, trên lượt có ghi offlineVoiceOk'),
  ]);
  const header = `# Chỉ số từ nhật ký thử nghiệm thật\n\nNguồn: ${source} · ${m.trials} lượt (${m.moneyTrials} có tiền, ${m.noMoneyTrials} không có tiền).`;
  return `${header}\n\n${table}\n`;
}