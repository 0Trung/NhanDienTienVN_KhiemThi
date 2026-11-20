import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import type { DecisionInput, Denomination } from '../../src/contracts';
import { DEFAULT_SPEECH_DURATION_MS, replayScenario } from '../../tools/scenario-replay/replay';
import { deriveGeneratorOptions } from '../../tools/scenario-replay/scenario';
import { STABLE_SINGLE_SCENARIOS } from '../../tools/scenario-replay/scenarios/single-notes';
import { LOW_CONFIDENCE_SCENARIO } from '../../tools/scenario-replay/scenarios/hard-cases';
import { OPTIONS, fakeDeps, oneNote, recognition, scenarioOf } from './helpers';
import { REAL_MODULES_READY } from './real-modules';

const FRAME_MS = deriveGeneratorOptions(DEFAULT_CONFIG).frameIntervalMs;
/** Engine giả công bố ngay ở khung đầu tiên với tổng cho trước. */
const publishFirst = (total: number, denominations: Denomination[] = [20000]) =>
  fakeDeps((n, now) => (n === 0 ? recognition(total, denominations, now) : null));

const analyses = (inputs: readonly DecisionInput[]): Array<Extract<DecisionInput, { type: 'ANALYSIS' }>> =>
  inputs.flatMap((i) => (i.type === 'ANALYSIS' ? [i] : []));
const systemEvents = (inputs: readonly DecisionInput[]): string[] => inputs.flatMap((i) => (i.type === 'SYSTEM' ? [i.event] : []));

describe('replayScenario · cơ chế phát lại (đồ giả)', () => {
  it('khởi động engine bằng đủ năm sự kiện hệ thống trước khung đầu tiên', () => {
    const { deps, inputs } = fakeDeps(() => null);
    replayScenario(scenarioOf(oneNote(3)), deps);
    expect(systemEvents(inputs)).toEqual(['APP_STARTED', 'GESTURE_UNLOCKED', 'PERMISSION_REQUESTED', 'MODEL_READY', 'CAMERA_READY']);
    expect(inputs.slice(0, 5).every((i) => i.type === 'SYSTEM')).toBe(true);
  });

  it('đồng hồ giả: now của engine bằng mốc của khung và bằng meta.timestamp', () => {
    const { deps, inputs } = fakeDeps(() => null);
    replayScenario(scenarioOf(oneNote(4)), deps);
    const seen = analyses(inputs);
    expect(seen.map((i) => i.now)).toEqual([0, 1, 2, 3].map((k) => k * FRAME_MS));
    expect(seen.every((i) => i.analysis.meta.timestamp === i.now)).toBe(true);
  });

  it.each([
    { speechMs: DEFAULT_SPEECH_DURATION_MS },
    { speechMs: 1000 },
    { speechMs: 5000 },
  ])('hết giọng nói sau đúng $speechMs ms: RESULT_SPEECH_ENDED có now = lúc công bố + thời lượng', ({ speechMs }) => {
    const { deps, inputs } = publishFirst(20000);
    replayScenario(scenarioOf(oneNote(30)), deps, { speechDurationMs: speechMs });
    const ended = inputs.findIndex((i) => i.type === 'SYSTEM' && i.event === 'RESULT_SPEECH_ENDED');
    const endedInput = inputs[ended];
    expect(endedInput?.now).toBe(speechMs);
    // Sự kiện đến ngay trước khung đầu tiên có mốc ≥ lúc hết giờ, không sớm hơn.
    const before = inputs.slice(0, ended).filter((i) => i.type === 'ANALYSIS').pop();
    const after = inputs.slice(ended + 1).find((i) => i.type === 'ANALYSIS');
    expect(before?.now).toBeLessThan(speechMs);
    expect(after?.now).toBeGreaterThanOrEqual(speechMs);
  });

  it('mặc định giọng nói giả kéo dài 2 giây', () => {
    expect(DEFAULT_SPEECH_DURATION_MS).toBe(2000);
  });

  it('chỉ gửi RESULT_SPEECH_ENDED khi có công bố', () => {
    const { deps, inputs } = fakeDeps(() => null);
    replayScenario(scenarioOf(oneNote(30)), deps);
    expect(systemEvents(inputs)).not.toContain('RESULT_SPEECH_ENDED');
  });

  it('mỗi lần công bố kéo theo đúng một RESULT_SPEECH_ENDED', () => {
    // Công bố ở các lần phân tích thứ 0 và thứ 20 (sau khi lần đầu đã nói xong).
    const { deps, inputs } = fakeDeps((n, now) => (n === 0 || n === 20 ? recognition(20000, [20000], now) : null));
    const outcome = replayScenario(scenarioOf(oneNote(30)), deps);
    expect(outcome.publications).toHaveLength(2);
    expect(systemEvents(inputs).filter((e) => e === 'RESULT_SPEECH_ENDED')).toHaveLength(2);
  });

  it('khung rơi chiếm thời gian nhưng không tới analyzer và engine', () => {
    const { deps, inputs } = fakeDeps(() => null);
    const outcome = replayScenario(scenarioOf(oneNote(10, { dropRate: 1 })), deps);
    expect(analyses(inputs)).toHaveLength(0);
    expect(outcome.frames).toHaveLength(10);
    expect(outcome.frames.every((f) => f.dropped)).toBe(true);
    expect(outcome.publications).toEqual([]);
  });

  it('khung rơi một phần: mốc thời gian các khung còn lại không đổi', () => {
    const { deps, inputs } = fakeDeps(() => null);
    const outcome = replayScenario(scenarioOf(oneNote(30, { dropRate: 0.5 })), deps, { seed: 4 });
    const delivered = outcome.frames.filter((f) => !f.dropped).map((f) => f.atMs);
    expect(analyses(inputs).map((i) => i.now)).toEqual(delivered);
    expect(delivered.every((ms) => ms % FRAME_MS === 0)).toBe(true);
    expect(delivered.length).toBeLessThan(30);
  });

  it('phát lại là xác định: cùng đầu vào cho cùng kết quả', () => {
    const run = () => replayScenario(scenarioOf(oneNote(30, { confidenceSigma: 0.05, dropRate: 0.2 })), publishFirst(20000).deps, { seed: 9 });
    expect(run()).toEqual(run());
  });
});

describe('replayScenario · ghi nhận công bố so với sự thật', () => {
  it.each<{ name: string; total: number; denominations: Denomination[]; truth: Denomination[] | null; correct: boolean; exactSet: boolean }>([
    { name: 'đúng tổng và đúng tập', total: 20000, denominations: [20000], truth: [20000], correct: true, exactSet: true },
    { name: 'sai tổng', total: 50000, denominations: [50000], truth: [20000], correct: false, exactSet: false },
    { name: 'đúng tổng nhưng sai tập', total: 20000, denominations: [10000, 10000], truth: [20000], correct: true, exactSet: false },
    { name: 'không có tiền mà vẫn đọc', total: 20000, denominations: [20000], truth: null, correct: false, exactSet: false },
  ])('$name', ({ total, denominations, truth, correct, exactSet }) => {
    const scenario = scenarioOf(oneNote(10), { groundTruth: truth });
    const outcome = replayScenario(scenario, publishFirst(total, denominations).deps);
    const [pub] = outcome.publications;
    expect(outcome.publications).toHaveLength(1);
    expect(pub?.correct).toBe(correct);
    expect(pub?.exactSet).toBe(exactSet);
    expect(pub?.truth).toEqual(truth);
    expect(pub?.truthTotal).toBe(truth === null ? null : truth.reduce((a, b) => a + b, 0));
  });

  it('ghi lại khung, thời điểm và mã lý do của lần công bố', () => {
    const outcome = replayScenario(scenarioOf(oneNote(10)), publishFirst(20000).deps);
    expect(outcome.publications[0]).toMatchObject({ slot: 0, frameId: 1, atMs: 0, reasons: ['FAKE'] });
  });

  it('seed và mã kịch bản được ghi vào kết quả', () => {
    const outcome = replayScenario(scenarioOf(oneNote(2)), fakeDeps(() => null).deps, { seed: 77 });
    expect(outcome).toMatchObject({ scenarioId: 'test-scenario', seed: 77 });
    expect(OPTIONS.frameIntervalMs).toBe(FRAME_MS);
  });
});

describe.skipIf(!REAL_MODULES_READY)('replayScenario · module thật (FrameAnalyzer + DecisionEngine)', () => {
  it('một tờ ổn định cho đúng một lần công bố, đúng tổng', async () => {
    const { realDeps } = await import('../../tools/scenario-replay/real-deps');
    const scenario = STABLE_SINGLE_SCENARIOS.find((s) => s.id === 'single-20000');
    if (scenario === undefined) throw new Error('thiếu kịch bản single-20000');
    const outcome = replayScenario(scenario, realDeps);
    expect(outcome.publications).toHaveLength(1);
    expect(outcome.publications[0]).toMatchObject({ total: 20000, correct: true, exactSet: true, truthTotal: 20000 });
    expect(outcome.publications[0]?.reasons).toContain('CONFIRMED');
  });

  it('độ tin cậy 0,55 không bao giờ được đọc', async () => {
    const { realDeps } = await import('../../tools/scenario-replay/real-deps');
    expect(replayScenario(LOW_CONFIDENCE_SCENARIO, realDeps).publications).toEqual([]);
  });
});