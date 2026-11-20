import { describe, expect, it } from 'vitest';
import { computeLogMetrics } from '../../tools/metrics-from-log/metrics';
import type { LogRow } from '../../tools/metrics-from-log/parse-csv';
import { REPORT_SCHEMA, buildReport, renderMetricsTable } from '../../tools/metrics-from-log/report';

let nextLine = 2;
/** Lượt thử dựng tay; mặc định là một tờ đọc đúng, giọng nói không ghi nhận. */
function row(overrides: Partial<LogRow> = {}): LogRow {
  return {
    line: nextLine++, timestamp: 't', scenarioId: 'S', state: 'DONE', status: 'S',
    announcedTotal: 20000, groundTruthTotal: 20000, noteCountDetected: 1, noteCountTrue: 1, latencyMs: null, offlineVoiceOk: null,
    ...overrides,
  };
}

/** Không có tiền thật: tổng và số tờ thật đều 0. */
const noMoney = (overrides: Partial<LogRow> = {}): LogRow =>
  row({ announcedTotal: null, groundTruthTotal: 0, noteCountDetected: 0, noteCountTrue: 0, ...overrides });

/**
 * Bộ dữ liệu tính tay (10 lượt):
 *  1 đúng 20.000 · 2 đúng 50.000 · 3 sai (70.000 thay 20.000) · 4 từ chối · 5 đúng hai tờ 60.000 · 6 sai thiếu tờ (25.000 thay 125.000)
 *  7 không tiền, im lặng · 8 không tiền nhưng đọc 20.000 (dương tính giả) · 9 không tiền, không có noteCountDetected · 10 không tiền, im lặng
 */
const HAND_DATA: LogRow[] = [
  row({ latencyMs: 800, offlineVoiceOk: true }),
  row({ announcedTotal: 50000, groundTruthTotal: 50000, latencyMs: 1000, offlineVoiceOk: true }),
  row({ announcedTotal: 70000, latencyMs: 1200, offlineVoiceOk: false }),
  row({ announcedTotal: null }),
  row({ announcedTotal: 60000, groundTruthTotal: 60000, noteCountDetected: 2, noteCountTrue: 2, latencyMs: 2000, offlineVoiceOk: true }),
  row({ announcedTotal: 25000, groundTruthTotal: 125000, noteCountDetected: 2, noteCountTrue: 3, latencyMs: 900 }),
  noMoney(),
  noMoney({ announcedTotal: 20000, noteCountDetected: 1, latencyMs: 700 }),
  noMoney({ noteCountDetected: null }),
  noMoney(),
];

describe('computeLogMetrics · bộ dữ liệu tính tay', () => {
  const m = computeLogMetrics(HAND_DATA);

  it('đếm lượt: tổng, có tiền, không có tiền', () => {
    expect([m.trials, m.moneyTrials, m.noMoneyTrials]).toEqual([10, 6, 4]);
  });

  it('Total Accuracy = đọc đúng tổng / lượt có tiền (từ chối tính là chưa đúng): 3/6', () => {
    expect(m.totalAccuracy).toEqual({ numerator: 3, denominator: 6, value: 0.5 });
  });

  it('Unsafe Read Rate = công bố sai tổng (kể cả đọc khi không có tiền) / lượt đã công bố: 3/6', () => {
    expect(m.unsafeReadRate).toEqual({ numerator: 3, denominator: 6, value: 0.5 });
  });

  it('Rejection Rate = lượt không công bố / mọi lượt: 4/10', () => {
    expect(m.rejectionRate).toEqual({ numerator: 4, denominator: 10, value: 0.4 });
  });

  it('False Positive Rate = lượt không có tiền mà vẫn công bố / lượt không có tiền: 1/4', () => {
    expect(m.falsePositiveRate).toEqual({ numerator: 1, denominator: 4, value: 0.25 });
  });

  it('Note Count Accuracy chỉ tính trên lượt có tiền và có noteCountDetected: 5/6', () => {
    expect(m.noteCountAccuracy).toEqual({ numerator: 5, denominator: 6, value: 5 / 6 });
  });

  it('Detection Accuracy = đúng có/không có tiền, trên lượt có noteCountDetected (bỏ lượt 9): 8/9', () => {
    expect(m.detectionAccuracy).toEqual({ numerator: 8, denominator: 9, value: 8 / 9 });
  });

  it('Denomination Set Accuracy (ước lượng) = đúng cả tổng lẫn số tờ: 3/6', () => {
    expect(m.denominationSetAccuracy).toEqual({ numerator: 3, denominator: 6, value: 0.5 });
  });

  it('độ trễ chỉ lấy lượt đã công bố có latencyMs: trung bình 1100, p50 900, p95 2000 trên 6 mẫu', () => {
    expect(m.latencyMs).toEqual({ samples: 6, mean: 1100, p50: 900, p95: 2000 });
  });

  it('Offline Voice Success Rate chỉ tính trên lượt có ghi offlineVoiceOk: 3/4', () => {
    expect(m.offlineVoiceSuccessRate).toEqual({ numerator: 3, denominator: 4, value: 0.75 });
  });
});

describe('computeLogMetrics · biên', () => {
  it('danh sách rỗng: mọi tỷ lệ là không đo được (value null), không ném lỗi, không NaN', () => {
    const m = computeLogMetrics([]);
    const rates = [m.detectionAccuracy, m.noteCountAccuracy, m.denominationSetAccuracy, m.totalAccuracy, m.unsafeReadRate,
      m.rejectionRate, m.falsePositiveRate, m.offlineVoiceSuccessRate];
    expect(rates.map((r) => r.value)).toEqual(rates.map(() => null));
    expect(m.latencyMs).toEqual({ samples: 0, mean: null, p50: null, p95: null });
  });

  it('chỉ có lượt có tiền: False Positive Rate không đo được thay vì 0', () => {
    expect(computeLogMetrics([row()]).falsePositiveRate.value).toBeNull();
  });

  it('chỉ có lượt từ chối: Unsafe Read Rate không đo được (chưa công bố lần nào)', () => {
    expect(computeLogMetrics([row({ announcedTotal: null })]).unsafeReadRate.value).toBeNull();
  });

  it('độ trễ của lượt bị từ chối bị bỏ qua', () => {
    const m = computeLogMetrics([row({ latencyMs: 500 }), row({ announcedTotal: null, latencyMs: 99999 })]);
    expect(m.latencyMs).toMatchObject({ samples: 1, mean: 500, p95: 500 });
  });

  it('mọi lượt đều đọc đúng: Unsafe Read Rate = 0/N (đo được và bằng 0)', () => {
    const m = computeLogMetrics([row(), row({ announcedTotal: 50000, groundTruthTotal: 50000 })]);
    expect(m.unsafeReadRate).toEqual({ numerator: 0, denominator: 2, value: 0 });
  });
});

describe('báo cáo', () => {
  const metrics = computeLogMetrics(HAND_DATA);

  it('bảng markdown có đủ các chỉ số của mục 13.4', () => {
    const table = renderMetricsTable('log.csv', metrics);
    for (const name of [
      'Detection Accuracy', 'Note Count Accuracy', 'Denomination Set Accuracy', 'Total Accuracy', 'Unsafe Read Rate', 'Rejection Rate',
      'False Positive Rate', 'End-to-End Latency (trung bình)', 'End-to-End Latency (p50)', 'End-to-End Latency (p95)', 'Offline Voice Success Rate',
    ]) expect(table, name).toContain(name);
    expect(table).toContain('Nguồn: log.csv · 10 lượt (6 có tiền, 4 không có tiền).');
    expect(table).toContain('| Unsafe Read Rate | 50,0% (3/6) |');
  });

  it('bảng đánh dấu Denomination Set Accuracy là ước lượng', () => {
    expect(renderMetricsTable('log.csv', metrics)).toContain('Denomination Set Accuracy (ước lượng)');
  });

  it('report.json mang nhãn phiên bản, nguồn và mọi chỉ số; chỉ số không đo được giữ null qua JSON', () => {
    const parsed: unknown = JSON.parse(JSON.stringify(buildReport('log.csv', computeLogMetrics([row()]))));
    expect(parsed).toMatchObject({
      schema: REPORT_SCHEMA,
      source: 'log.csv',
      metrics: { trials: 1, totalAccuracy: { numerator: 1, denominator: 1, value: 1 }, falsePositiveRate: { numerator: 0, denominator: 0, value: null } },
    });
  });
});