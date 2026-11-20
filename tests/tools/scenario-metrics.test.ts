import { describe, expect, it } from 'vitest';
import type { Denomination } from '../../src/contracts';
import { aggregateMetrics, computeScenarioMetrics, splitByLimitation } from '../../tools/scenario-replay/metrics';
import type { ScenarioMetrics } from '../../tools/scenario-replay/metrics';
import type { FrameRecord, PublicationRecord, ReplayOutcome } from '../../tools/scenario-replay/replay';
import type { Expectation, Scenario } from '../../tools/scenario-replay/scenario';
import { oneNote, scenarioOf } from './helpers';

/** Số khung trống liên tiếp để coi tiền đã rời khung (emptyFramesToReset mặc định). */
const LEAVE = 6;
const STEP_MS = 100;

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Khe thời gian dựng tay: có tiền / không tiền, rơi hay không, có hướng dẫn hay không. */
function frame(slot: number, opts: Partial<Pick<FrameRecord, 'moneyPresent' | 'dropped' | 'guidance'>> = {}): FrameRecord {
  return { slot, frameId: slot + 1, atMs: slot * STEP_MS, dropped: false, moneyPresent: true, guidance: false, ...opts };
}

/** `count` khe liên tiếp bắt đầu từ `from`. */
const frames = (from: number, count: number, opts: Partial<Pick<FrameRecord, 'moneyPresent' | 'dropped' | 'guidance'>> = {}): FrameRecord[] =>
  Array.from({ length: count }, (_, k) => frame(from + k, opts));

/** Lần công bố dựng tay; correct và exactSet suy ra từ sự thật như replay thật. */
function pub(slot: number, announced: Denomination[], truth: readonly Denomination[] | null): PublicationRecord {
  const truthTotal = truth === null ? null : sum(truth);
  const total = sum(announced);
  return {
    slot, frameId: slot + 1, atMs: slot * STEP_MS, denominations: announced, total, truth, truthTotal,
    correct: truthTotal !== null && total === truthTotal,
    exactSet: truth !== null && announced.length === truth.length && announced.every((d, i) => d === truth[i]),
    reasons: ['CONFIRMED'], agree: 4, detectedCount: announced.length,
  };
}

const outcomeOf = (fr: FrameRecord[], pubs: PublicationRecord[]): ReplayOutcome => ({ scenarioId: 'test-scenario', seed: 1, frames: fr, publications: pubs });
const metricsOf = (scenario: Scenario, fr: FrameRecord[], pubs: PublicationRecord[]): ScenarioMetrics =>
  computeScenarioMetrics(scenario, outcomeOf(fr, pubs), LEAVE);

const publishScenario = scenarioOf(oneNote(1));
const rejectScenario = (truth: readonly Denomination[] | null): Scenario => scenarioOf(oneNote(1), { expectation: 'REJECT', groundTruth: truth });

describe('computeScenarioMetrics · Unsafe Read', () => {
  it.each<{ name: string; announced: Denomination[]; truth: readonly Denomination[] | null; unsafe: number; mismatch: number }>([
    { name: 'đúng tổng, đúng tập', announced: [20000], truth: [20000], unsafe: 0, mismatch: 0 },
    { name: 'sai mệnh giá', announced: [50000], truth: [20000], unsafe: 1, mismatch: 0 },
    { name: 'không có tiền mà vẫn đọc', announced: [20000], truth: null, unsafe: 1, mismatch: 0 },
    { name: 'đọc thiếu một tờ', announced: [5000, 20000], truth: [5000, 20000, 100000], unsafe: 1, mismatch: 0 },
    { name: 'đúng tổng nhưng khác tập: không phải Unsafe, được đếm riêng', announced: [10000, 10000], truth: [20000], unsafe: 0, mismatch: 1 },
  ])('$name', ({ announced, truth, unsafe, mismatch }) => {
    const m = metricsOf(publishScenario, frames(0, 10), [pub(3, announced, truth)]);
    expect(m.publications).toBe(1);
    expect(m.unsafeReads).toBe(unsafe);
    expect(m.correctReads).toBe(1 - unsafe);
    expect(m.setMismatches).toBe(mismatch);
  });

  it.each<{ name: string; announced: Denomination[]; truth: readonly Denomination[] | null; cause: RegExp }>([
    { name: 'không có tiền', announced: [20000], truth: null, cause: /không có tiền/ },
    { name: 'sai số tờ', announced: [5000, 20000], truth: [5000, 20000, 100000], cause: /thấy 2 tờ.*có 3 tờ/ },
    { name: 'sai mệnh giá', announced: [50000], truth: [20000], cause: /đọc 50000 nhưng sự thật 20000/ },
  ])('chi tiết lần đọc sai ($name) nêu rõ nguyên nhân, khung và mã engine', ({ announced, truth, cause }) => {
    const [detail] = metricsOf(publishScenario, frames(0, 10), [pub(3, announced, truth)]).unsafeDetails;
    expect(detail).toMatchObject({ scenarioId: 'test-scenario', seed: 1, slot: 3, frameId: 4, atMs: 3 * STEP_MS, reasons: ['CONFIRMED'] });
    expect(detail?.cause).toMatch(cause);
  });
});

describe('computeScenarioMetrics · từ chối đúng và bỏ lỡ', () => {
  it.each<{ expectation: Expectation; pubs: number; rejection: boolean | null; missed: boolean | null }>([
    { expectation: 'REJECT', pubs: 0, rejection: true, missed: null },
    { expectation: 'REJECT', pubs: 1, rejection: false, missed: null },
    { expectation: 'PUBLISH', pubs: 0, rejection: null, missed: true },
    { expectation: 'PUBLISH', pubs: 1, rejection: null, missed: false },
  ])('kỳ vọng $expectation với $pubs lần công bố', ({ expectation, pubs, rejection, missed }) => {
    const scenario = scenarioOf(oneNote(1), { expectation });
    const published = Array.from({ length: pubs }, (_, i) => pub(3 + i * 20, [20000], [20000]));
    const m = metricsOf(scenario, frames(0, 10), published);
    expect(m.correctRejection).toBe(rejection);
    expect(m.missedRead).toBe(missed);
  });

  it('kịch bản cần đọc mà chỉ đọc sai vẫn bị tính là bỏ lỡ lần đọc đúng', () => {
    expect(metricsOf(publishScenario, frames(0, 10), [pub(3, [50000], [20000])]).missedRead).toBe(true);
  });
});

describe('computeScenarioMetrics · đọc lặp', () => {
  const twice = (gap: number, second: Denomination[] = [20000]): ScenarioMetrics => {
    const secondSlot = 4 + gap + 1;
    const fr = [...frames(0, 4), ...frames(4, gap, { moneyPresent: false }), ...frames(4 + gap, 20)];
    return metricsOf(publishScenario, fr, [pub(3, [20000], [20000]), pub(secondSlot, second, second)]);
  };

  it.each([
    { gap: 0, repeated: 1, note: 'tiền không rời khung' },
    { gap: LEAVE - 1, repeated: 1, note: 'vắng ngắn hơn ngưỡng rời khung một khung' },
    { gap: LEAVE, repeated: 0, note: 'vắng đúng bằng ngưỡng: tiền đã rời khung' },
    { gap: LEAVE + 4, repeated: 0, note: 'vắng lâu: đưa lại là lần đọc mới hợp lệ' },
  ])('cùng tập, $note', ({ gap, repeated }) => {
    expect(twice(gap).repeatedReads).toBe(repeated);
  });

  it('khác tập thì không phải đọc lặp dù tiền không rời khung', () => {
    expect(twice(0, [50000]).repeatedReads).toBe(0);
  });

  it('khung rơi giữa hai lần công bố không phá chuỗi khung vắng (khung rơi tính là thời gian trôi)', () => {
    const fr = [...frames(0, 4), ...frames(4, LEAVE, { moneyPresent: false, dropped: true }), ...frames(10, 20)];
    const m = metricsOf(publishScenario, fr, [pub(3, [20000], [20000]), pub(12, [20000], [20000])]);
    expect(m.repeatedReads).toBe(0);
  });
});

describe('computeScenarioMetrics · thời gian tới lần đọc đầu và hướng dẫn', () => {
  it('đếm khung tới analyzer (bỏ khung rơi) và mili-giây giả từ lúc tiền xuất hiện', () => {
    const fr = [...frames(0, 2, { moneyPresent: false }), frame(2), frame(3, { dropped: true }), frame(4), frame(5)];
    const m = metricsOf(publishScenario, fr, [pub(5, [20000], [20000])]);
    expect(m.firstPublication).toEqual({ frames: 3, ms: 3 * STEP_MS });
  });

  it('không có tiền trong cảnh thì không có thời gian tới lần đọc đầu', () => {
    expect(metricsOf(rejectScenario(null), frames(0, 5, { moneyPresent: false }), [pub(3, [20000], null)]).firstPublication).toBeNull();
  });

  it('không công bố thì không có thời gian tới lần đọc đầu', () => {
    expect(metricsOf(publishScenario, frames(0, 5), []).firstPublication).toBeNull();
  });

  it('đếm khung hướng dẫn và khung tới analyzer', () => {
    const fr = [frame(0, { guidance: true }), frame(1, { guidance: true }), frame(2), frame(3, { dropped: true, guidance: false })];
    const m = metricsOf(publishScenario, fr, []);
    expect(m.guidanceFrames).toBe(2);
    expect(m.deliveredFrames).toBe(3);
  });
});

describe('aggregateMetrics', () => {
  const ok = metricsOf(publishScenario, frames(0, 10), [pub(3, [20000], [20000])]);
  const unsafe = metricsOf(publishScenario, frames(0, 10), [pub(3, [50000], [20000])]);
  const silent = metricsOf(publishScenario, frames(0, 10), []);
  const rejectOk = metricsOf(rejectScenario([20000]), frames(0, 10), []);
  const rejectBad = metricsOf(rejectScenario(null), frames(0, 10), [pub(3, [20000], null)]);

  it('Unsafe Read Rate = đọc sai / công bố, kèm tử số và mẫu số', () => {
    const a = aggregateMetrics([ok, unsafe, rejectBad]);
    expect(a.unsafeReadRate).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 });
  });

  it('Rejection Rate chỉ tính trên kịch bản kỳ vọng REJECT', () => {
    const a = aggregateMetrics([ok, rejectOk, rejectBad]);
    expect(a.rejectionRate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });

  it('Đọc đúng khi cần đọc chỉ tính trên kịch bản PUBLISH (chặn lối từ chối tất cả)', () => {
    const a = aggregateMetrics([ok, unsafe, silent, rejectOk]);
    expect(a.readSuccessRate).toEqual({ numerator: 1, denominator: 3, value: 1 / 3 });
  });

  it('danh sách rỗng cho mọi tỷ lệ không đo được thay vì NaN', () => {
    const a = aggregateMetrics([]);
    expect([a.unsafeReadRate.value, a.rejectionRate.value, a.readSuccessRate.value, a.guidanceShare.value]).toEqual([null, null, null, null]);
    expect([a.firstPublicationFramesMean, a.firstPublicationMsMean, a.firstPublicationMsMax]).toEqual([null, null, null]);
  });

  it('thời gian tới lần đọc đầu: trung bình và lớn nhất trên các kịch bản có đọc', () => {
    const slow = metricsOf(publishScenario, frames(0, 10), [pub(7, [20000], [20000])]);
    const a = aggregateMetrics([ok, slow]);
    expect(a.firstPublicationMsMean).toBe(((3 + 7) / 2) * STEP_MS);
    expect(a.firstPublicationMsMax).toBe(7 * STEP_MS);
  });
});

describe('splitByLimitation', () => {
  const normal = metricsOf(publishScenario, frames(0, 10), [pub(3, [20000], [20000])]);
  const known = metricsOf(scenarioOf(oneNote(1), { knownLimitation: true }), frames(0, 10), [pub(3, [50000], [20000])]);

  it('hạn chế đã biết tách khỏi nhóm chính, không mất kịch bản nào', () => {
    const { main, known: limited } = splitByLimitation([normal, known]);
    expect(main).toEqual([normal]);
    expect(limited).toEqual([known]);
  });

  it('Unsafe Read của hạn chế đã biết không lọt vào tổng hợp nhóm chính nhưng vẫn có ở tổng hợp riêng', () => {
    const { main, known: limited } = splitByLimitation([normal, known]);
    expect(aggregateMetrics(main).unsafeReads).toBe(0);
    expect(aggregateMetrics(limited).unsafeReads).toBe(1);
  });
});