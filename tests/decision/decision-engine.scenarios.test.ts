// Lượt 2: kịch bản nhánh ANALYSIS 1..7, cooldown, anti-repeat, SPEAKING, USER_REPLAY có kết quả.
import { describe, expect, it } from 'vitest';
import type { DecisionOutput, DecisionStatus, Denomination, FrameAnalysis, GuidanceCode } from '../../src/contracts';
import {
  makeAnalysis, makeConflictAnalysis, makeDetection, makeOverlapAnalysis, makeSingleSureAnalysis, makeStableAnalysis, makeUnsureAnalysis,
} from '../fakes/factories';
import { FRAME_MS, cfg, feed, frame, readyEngine, sys } from './harness';

const at = (i: number): number => i * FRAME_MS;
const published = (outs: DecisionOutput[]): DecisionOutput[] => outs.filter((o) => o.result !== null);
const spoken = (outs: DecisionOutput[], code: GuidanceCode): number[] =>
  outs.flatMap((o, i) => (o.speech?.kind === 'GUIDANCE' && o.speech.code === code ? [i] : []));
const stableWith = (a: FrameAnalysis): FrameAnalysis => ({ ...a, stability: { stable: true, agree: 5, window: 5, consensus: a.detections } });
const PARTIAL = { position: { tooSmall: false, partial: true } };
const BLURRY = { quality: { blurScore: 10, blurry: true, brightness: 120, lowLight: false } };
const DARK = { quality: { blurScore: 200, blurry: false, brightness: 20, lowLight: true } };

/** Engine đã đọc một tờ 20.000 và đã đọc xong (state DETECTING); trả engine và mốc thời gian kế tiếp. */
function afterFirstResult(): { engine: ReturnType<typeof readyEngine>; next: number } {
  const engine = readyEngine();
  const out = engine.handle(frame(makeStableAnalysis([20000]), 0));
  expect(out.result).not.toBeNull();
  engine.handle(sys('RESULT_SPEECH_ENDED', FRAME_MS));
  return { engine, next: 2 * FRAME_MS };
}

describe('đọc đúng một lần', () => {
  it('tiền xuất hiện rồi ổn định: 30 khung liên tiếp chỉ đọc ĐÚNG 1 lần', () => {
    const engine = readyEngine();
    [makeAnalysis(), makeSingleSureAnalysis(20000), makeSingleSureAnalysis(20000)].forEach((a, i) => engine.handle(frame(a, at(i))));
    const outs = feed(engine, makeStableAnalysis([20000]), 30, at(3));
    expect(published(outs)).toHaveLength(1);
    expect(outs[0]).toMatchObject({ state: 'SPEAKING', status: 'CONFIDENT_SINGLE', reasons: ['CONFIRMED'], shouldCalculateTotal: true });
    expect(outs[0]?.result).toMatchObject({ count: 1, denominations: [20000], total: 20000, formattedTotal: '20.000 đồng' });
    expect(outs[0]?.speech).toEqual({ kind: 'RESULT', result: outs[0]?.result });
    expect(outs.slice(1).every((o) => o.speech === null && o.result === null)).toBe(true);
  });

  it('đã đọc xong mà tiền vẫn trong khung: 29 khung kế tiếp đều ANTI_REPEAT, im lặng', () => {
    const { engine, next } = afterFirstResult();
    for (const o of feed(engine, makeStableAnalysis([20000]), 29, next)) {
      expect(o).toMatchObject({ state: 'DETECTING', status: 'CONFIDENT_SINGLE', reasons: ['ANTI_REPEAT'], speech: null, result: null, shouldCalculateTotal: false });
    }
  });

  it('kết quả nhiều tờ giữ thứ tự trái → phải, đủ tổng và định dạng', () => {
    const out = readyEngine().handle(frame(makeStableAnalysis([20000, 50000, 100000]), 1234));
    expect(out.status).toBe('CONFIDENT_MULTI');
    expect(out.result).toEqual({
      status: 'CONFIDENT_MULTI', count: 3, denominations: [20000, 50000, 100000], total: 170000, formattedTotal: '170.000 đồng', timestamp: 1234,
    });
  });
});

describe('tiền rời khung rồi quay lại', () => {
  const emptyRun = (n: number) => (i: number) => makeAnalysis({ emptyStreak: Math.min(i + 1, n) });

  it('rời khung đủ emptyFramesToReset khung rồi vào lại thì đọc lại', () => {
    const { engine, next } = afterFirstResult();
    const empties = feed(engine, emptyRun(6), 6, next);
    expect(empties[5]?.reasons).toEqual(['NO_DETECTIONS', 'SIGNATURE_RESET', 'GUIDANCE_WAIT']);
    const back = engine.handle(frame(makeStableAnalysis([20000]), next + at(6)));
    expect(back.result).toMatchObject({ denominations: [20000] });
  });

  it('rời khung ngắn hơn ngưỡng thì vào lại KHÔNG đọc lại', () => {
    const { engine, next } = afterFirstResult();
    feed(engine, emptyRun(5), 5, next);
    expect(engine.handle(frame(makeStableAnalysis([20000]), next + at(5))).reasons).toEqual(['ANTI_REPEAT']);
  });

  it('tiền rời khung ngay khi đang đọc: bộ đếm trống vẫn chạy, đọc xong và vào lại thì đọc lại', () => {
    const engine = readyEngine();
    engine.handle(frame(makeStableAnalysis([20000]), 0));
    const empties = feed(engine, emptyRun(6), 6, FRAME_MS);
    expect(empties.every((o) => o.state === 'SPEAKING' && o.reasons[1] === 'SPEAKING')).toBe(true);
    expect(empties[5]?.reasons).toEqual(['ANALYSIS_IGNORED', 'SPEAKING', 'SIGNATURE_RESET']);
    engine.handle(sys('RESULT_SPEECH_ENDED', at(7)));
    expect(engine.handle(frame(makeStableAnalysis([20000]), at(8))).result).not.toBeNull();
  });

  it('đổi chỗ hai tờ (thứ tự trái → phải khác) là chữ ký khác nên được đọc lại', () => {
    const engine = readyEngine();
    engine.handle(frame(makeStableAnalysis([20000, 50000]), 0));
    engine.handle(sys('RESULT_SPEECH_ENDED', FRAME_MS));
    const swapped = engine.handle(frame(makeStableAnalysis([50000, 20000]), at(2)));
    expect(swapped.result).toMatchObject({ denominations: [50000, 20000], total: 70000 });
  });

  it('đổi sang tờ khác khi tiền vẫn trong khung: chờ ổn định rồi đọc tờ mới', () => {
    const { engine, next } = afterFirstResult();
    const moving = feed(engine, makeSingleSureAnalysis(50000), 3, next);
    expect(moving.every((o) => o.status === 'UNSTABLE' && o.state === 'STABILIZING' && o.result === null && o.speech === null)).toBe(true);
    const out = engine.handle(frame(makeStableAnalysis([50000]), next + at(3)));
    expect(out.result).toMatchObject({ denominations: [50000], total: 50000, formattedTotal: '50.000 đồng' });
  });
});

describe('khung bị từ chối: không đọc tổng, có lời hướng dẫn', () => {
  it.each<{ name: string; analysis: FrameAnalysis; status: DecisionStatus; state: string; code: GuidanceCode; reasons: string[] }>([
    {
      name: 'một tờ confidence 0,55', analysis: makeUnsureAnalysis(20000, 0.55), status: 'LOW_CONFIDENCE', state: 'UNCERTAIN',
      code: 'LOW_CONFIDENCE', reasons: ['UNSURE_PRESENT', 'CAUSE_LOW_CONFIDENCE', 'GUIDANCE_SPOKEN'],
    },
    { name: 'chồng lấn', analysis: makeOverlapAnalysis(), status: 'OVERLAP', state: 'OVERLAPPING', code: 'OVERLAP', reasons: ['OVERLAP', 'GUIDANCE_SPOKEN'] },
    { name: 'xung đột lớp', analysis: makeConflictAnalysis(), status: 'CLASS_CONFLICT', state: 'UNCERTAIN', code: 'CLASS_CONFLICT', reasons: ['CONFLICT', 'GUIDANCE_SPOKEN'] },
    {
      name: 'xung đột và chồng lấn cùng lúc (xung đột thắng)',
      analysis: makeConflictAnalysis(20000, 50000, { overlap: { detected: true, maxRatio: 0.5, pairs: [] } }),
      status: 'CLASS_CONFLICT', state: 'UNCERTAIN', code: 'CLASS_CONFLICT', reasons: ['CONFLICT', 'GUIDANCE_SPOKEN'],
    },
  ])('$name', ({ analysis, status, state, code, reasons }) => {
    for (const a of [analysis, stableWith(analysis)]) {
      // Lần hai cho khung tự khai "ổn định": nhánh 1..4 vẫn thắng nhánh 7.
      const out = readyEngine().handle(frame(a, 0));
      expect(out).toMatchObject({ status, state, reasons, speech: { kind: 'GUIDANCE', code }, result: null, shouldCalculateTotal: false });
    }
  });

  it.each<{ name: string; patch: Partial<ReturnType<typeof cfg>>; analysis: FrameAnalysis; status?: DecisionStatus }>([
    { name: 'che khuất + blockOnPartial (mặc định)', patch: {}, analysis: makeStableAnalysis([20000], PARTIAL), status: 'PARTIAL_IN_FRAME' },
    { name: 'che khuất + tắt blockOnPartial', patch: { blockOnPartial: false }, analysis: makeStableAnalysis([20000], PARTIAL) },
    { name: 'mờ, mặc định không chặn', patch: {}, analysis: makeStableAnalysis([20000], BLURRY) },
    { name: 'mờ + blockOnBlur', patch: { blockOnBlur: true }, analysis: makeStableAnalysis([20000], BLURRY), status: 'BLUR' },
    { name: 'thiếu sáng, mặc định không chặn', patch: {}, analysis: makeStableAnalysis([20000], DARK) },
    { name: 'thiếu sáng + blockOnLowLight', patch: { blockOnLowLight: true }, analysis: makeStableAnalysis([20000], DARK), status: 'LOW_LIGHT' },
    { name: 'hai tờ + SINGLE_ONLY', patch: { multiNotePolicy: 'SINGLE_ONLY' }, analysis: makeStableAnalysis([20000, 50000]), status: 'MULTI_NOT_ALLOWED' },
    { name: 'hai tờ + MULTI (mặc định)', patch: {}, analysis: makeStableAnalysis([20000, 50000]) },
    { name: 'một tờ + SINGLE_ONLY', patch: { multiNotePolicy: 'SINGLE_ONLY' }, analysis: makeStableAnalysis([20000]) },
  ])('chặn theo cờ cấu hình: $name', ({ patch, analysis, status }) => {
    const out = readyEngine(patch).handle(frame(analysis, 0));
    if (status === undefined) {
      expect(out.result).not.toBeNull();
      return;
    }
    expect(out).toMatchObject({ status, state: 'UNCERTAIN', reasons: [`BLOCKED_${status}`, 'GUIDANCE_SPOKEN'], speech: { kind: 'GUIDANCE', code: status }, result: null });
  });

  it('thứ tự chặn ở nhánh 5: che khuất, rồi mờ, rồi thiếu sáng, rồi nhiều tờ', () => {
    const all = { blockOnPartial: true, blockOnBlur: true, blockOnLowLight: true, multiNotePolicy: 'SINGLE_ONLY' } as const;
    const flags = { position: { tooSmall: false, partial: true }, quality: { blurScore: 10, blurry: true, brightness: 20, lowLight: true } };
    const frames: Array<[Partial<FrameAnalysis>, DecisionStatus]> = [
      [flags, 'PARTIAL_IN_FRAME'],
      [{ ...flags, position: { tooSmall: false, partial: false } }, 'BLUR'],
      [{ quality: { blurScore: 200, blurry: false, brightness: 20, lowLight: true } }, 'LOW_LIGHT'],
      [{}, 'MULTI_NOT_ALLOWED'],
    ];
    for (const [patch, status] of frames) {
      expect(readyEngine(all).handle(frame(makeStableAnalysis([20000, 50000], patch), 0)).status).toBe(status);
    }
  });
});

describe('lời hướng dẫn ở nhánh 4 theo guidancePriority', () => {
  it.each<{ name: string; analysis: Partial<FrameAnalysis>; priority?: GuidanceCode[]; code: GuidanceCode }>([
    { name: 'chỉ có tờ chưa chắc', analysis: {}, code: 'LOW_CONFIDENCE' },
    { name: 'tờ quá nhỏ', analysis: { position: { tooSmall: true, partial: false } }, code: 'TOO_FAR' },
    { name: 'che khuất + thiếu sáng + mờ: che khuất đứng đầu', analysis: { ...PARTIAL, ...BLURRY, quality: { blurScore: 10, blurry: true, brightness: 20, lowLight: true } }, code: 'PARTIAL_IN_FRAME' },
    { name: 'thiếu sáng + mờ: thiếu sáng đứng trước mờ', analysis: { quality: { blurScore: 10, blurry: true, brightness: 20, lowLight: true } }, code: 'LOW_LIGHT' },
    { name: 'chỉ mờ', analysis: BLURRY, code: 'BLUR' },
    { name: 'đổi thứ tự ưu tiên: mờ lên đầu', analysis: { ...PARTIAL, ...BLURRY }, priority: ['BLUR', 'PARTIAL_IN_FRAME', 'LOW_CONFIDENCE'], code: 'BLUR' },
    { name: 'danh sách ưu tiên không chứa nguyên nhân nào: về LOW_CONFIDENCE', analysis: PARTIAL, priority: [], code: 'LOW_CONFIDENCE' },
  ])('$name → $code', ({ analysis, priority, code }) => {
    const out = readyEngine(priority === undefined ? {} : { guidancePriority: priority }).handle(frame(makeUnsureAnalysis(20000, 0.5, analysis), 0));
    expect(out.status).toBe('LOW_CONFIDENCE');
    expect(out.speech).toEqual({ kind: 'GUIDANCE', code });
    expect(out.reasons).toContain(`CAUSE_${code}`);
  });
});

describe('guidance: cooldown, thời gian chờ', () => {
  it('cùng guidance không lặp trong guidanceCooldownMs (mặc định 6000 ms)', () => {
    const outs = feed(readyEngine(), makeOverlapAnalysis(), 22);
    expect(spoken(outs, 'OVERLAP')).toEqual([0, 20]);
    expect(outs[1]?.reasons).toEqual(['OVERLAP', 'GUIDANCE_COOLDOWN']);
  });

  it('cooldown tính riêng theo từng mã', () => {
    const engine = readyEngine();
    const say = (a: FrameAnalysis, t: number): DecisionOutput => engine.handle(frame(a, t));
    expect(say(makeConflictAnalysis(), 0).speech).toEqual({ kind: 'GUIDANCE', code: 'CLASS_CONFLICT' });
    expect(say(makeOverlapAnalysis(), 300).speech).toEqual({ kind: 'GUIDANCE', code: 'OVERLAP' });
    expect(say(makeConflictAnalysis(), 600).speech).toBeNull();
    expect(say(makeOverlapAnalysis(), 900).speech).toBeNull();
    expect(say(makeConflictAnalysis(), 6000).speech).toEqual({ kind: 'GUIDANCE', code: 'CLASS_CONFLICT' });
  });

  it('NO_MONEY chỉ được nói sau khi trống liên tục đủ 4000 ms, rồi tuân thủ cooldown', () => {
    const outs = feed(readyEngine(), (i) => makeAnalysis({ emptyStreak: i + 1 }), 36);
    expect(spoken(outs, 'NO_MONEY')).toEqual([14, 34]);
    expect(outs[0]).toMatchObject({ state: 'NO_CANDIDATE', status: 'NO_MONEY_CANDIDATE', reasons: ['NO_DETECTIONS', 'GUIDANCE_WAIT'], speech: null });
    expect(outs[15]?.reasons).toEqual(['NO_DETECTIONS', 'GUIDANCE_COOLDOWN']);
  });

  it('tiền xuất hiện giữa chừng thì thời gian chờ NO_MONEY tính lại từ đầu', () => {
    const engine = readyEngine();
    feed(engine, (i) => makeAnalysis({ emptyStreak: i + 1 }), 10);
    engine.handle(frame(makeSingleSureAnalysis(20000), at(10)));
    const outs = feed(engine, (i) => makeAnalysis({ emptyStreak: i + 1 }), 16, at(11));
    expect(spoken(outs, 'NO_MONEY')).toEqual([14]);
  });

  it('chưa ổn định: im lặng, quá unstableGuidanceMs (5000 ms) mới nói HOLD_STEADY, rồi tuân thủ cooldown', () => {
    const outs = feed(readyEngine(), makeSingleSureAnalysis(20000), 38);
    expect(spoken(outs, 'HOLD_STEADY')).toEqual([17, 37]);
    expect(outs[0]).toMatchObject({ state: 'STABILIZING', status: 'UNSTABLE', reasons: ['UNSTABLE', 'GUIDANCE_WAIT'], speech: null });
    expect(outs[18]?.reasons).toEqual(['UNSTABLE', 'GUIDANCE_COOLDOWN']);
  });

  it('một khung rẽ sang nhánh khác thì thời gian chờ HOLD_STEADY tính lại từ đầu', () => {
    const engine = readyEngine();
    feed(engine, makeSingleSureAnalysis(20000), 10);
    engine.handle(frame(makeUnsureAnalysis(), at(10)));
    const outs = feed(engine, makeSingleSureAnalysis(20000), 20, at(11));
    expect(spoken(outs, 'HOLD_STEADY')).toEqual([17]);
  });
});

describe('SPEAKING, nền, replay, reset', () => {
  it('SPEAKING bỏ qua phân tích cho tới khi có RESULT_SPEECH_ENDED, rồi quét lại bình thường', () => {
    const engine = readyEngine();
    engine.handle(frame(makeStableAnalysis([20000]), 0));
    for (const a of [makeOverlapAnalysis(), makeUnsureAnalysis(), makeConflictAnalysis(), makeStableAnalysis([50000])]) {
      expect(engine.handle(frame(a, FRAME_MS))).toMatchObject({ state: 'SPEAKING', status: null, speech: null, result: null, reasons: ['ANALYSIS_IGNORED', 'SPEAKING'] });
    }
    expect(engine.handle(sys('RESULT_SPEECH_ENDED', at(2)))).toMatchObject({ state: 'DETECTING', speech: null });
    expect(engine.handle(frame(makeOverlapAnalysis(), at(3)))).toMatchObject({ state: 'OVERLAPPING', status: 'OVERLAP' });
  });

  it('APP_FOREGROUNDED xóa chữ ký: cùng tờ được đọc lại, nhưng lastResult vẫn còn', () => {
    const { engine, next } = afterFirstResult();
    engine.handle(sys('APP_BACKGROUNDED', next));
    expect(engine.handle(frame(makeStableAnalysis([20000]), next)).reasons).toEqual(['ANALYSIS_IGNORED', 'BACKGROUNDED']);
    engine.handle(sys('APP_FOREGROUNDED', next));
    expect(engine.lastResult).toMatchObject({ denominations: [20000] });
    expect(engine.handle(frame(makeStableAnalysis([20000]), next)).result).not.toBeNull();
  });

  it('USER_REPLAY có kết quả: đọc lại đúng kết quả đã công bố, không đổi trạng thái, không phải kết quả mới', () => {
    const engine = readyEngine();
    const first = engine.handle(frame(makeStableAnalysis([20000, 50000]), 0));
    for (const state of ['SPEAKING', 'DETECTING'] as const) {
      const out = engine.handle({ type: 'USER_REPLAY', now: FRAME_MS });
      expect(out).toMatchObject({ state, status: null, reasons: ['USER_REPLAY', 'HAS_RESULT'], result: null, shouldCalculateTotal: false });
      expect(out.speech).toEqual({ kind: 'REPLAY', result: first.result });
      engine.handle(sys('RESULT_SPEECH_ENDED', FRAME_MS));
    }
    expect(engine.lastResult).toEqual(first.result);
  });

  it('sửa result đã nhận hoặc lastResult không làm hỏng bản engine giữ', () => {
    const engine = readyEngine();
    const out = engine.handle(frame(makeStableAnalysis([20000]), 0));
    out.result?.denominations.push(500000);
    engine.lastResult?.denominations.push(500000);
    expect(engine.lastResult?.denominations).toEqual([20000]);
    const replay = engine.handle({ type: 'USER_REPLAY', now: 0 });
    expect(replay.speech).toMatchObject({ kind: 'REPLAY', result: { denominations: [20000], total: 20000 } });
  });

  it('reset() xóa kết quả và chữ ký: vẫn đọc lại được tờ cũ sau khi khởi động lại', () => {
    const { engine } = afterFirstResult();
    engine.reset();
    for (const event of ['APP_STARTED', 'GESTURE_UNLOCKED', 'PERMISSION_REQUESTED', 'MODEL_READY', 'CAMERA_READY'] as const) engine.handle(sys(event));
    expect(engine.lastResult).toBeNull();
    expect(engine.handle({ type: 'USER_REPLAY', now: 0 }).speech).toEqual({ kind: 'REPLAY_EMPTY' });
    expect(engine.handle(frame(makeStableAnalysis([20000]), 0)).result).not.toBeNull();
  });
});

describe('khung hỏng không làm engine ném lỗi hay đọc nhầm', () => {
  const one = makeStableAnalysis([20000]);
  const withStability = (stability: FrameAnalysis['stability']): FrameAnalysis => makeStableAnalysis([20000], { stability });

  it.each<{ name: string; analysis: FrameAnalysis; reasons: string[] }>([
    { name: 'ổn định nhưng consensus = null', analysis: withStability({ stable: true, agree: 5, window: 5, consensus: null }), reasons: ['UNSTABLE', 'NO_CONSENSUS', 'GUIDANCE_WAIT'] },
    { name: 'ổn định nhưng consensus rỗng', analysis: withStability({ stable: true, agree: 5, window: 5, consensus: [] }), reasons: ['UNSTABLE', 'NO_CONSENSUS', 'GUIDANCE_WAIT'] },
    { name: 'chưa ổn định nhưng còn consensus cũ', analysis: withStability({ stable: false, agree: 1, window: 5, consensus: one.detections }), reasons: ['UNSTABLE', 'GUIDANCE_WAIT'] },
    {
      name: 'consensus có mệnh giá không tồn tại',
      analysis: withStability({ stable: true, agree: 5, window: 5, consensus: [makeDetection({ denomination: 15000 as Denomination })] }),
      reasons: ['UNSTABLE', 'TOTAL_FAILED'],
    },
  ])('$name', ({ analysis, reasons }) => {
    const out = readyEngine().handle(frame(analysis, 0));
    expect(out).toMatchObject({ state: 'STABILIZING', status: 'UNSTABLE', reasons, speech: null, result: null, shouldCalculateTotal: false });
  });

  it('SINGLE_ONLY: consensus nhiều tờ hơn detections vẫn bị chặn', () => {
    const two = makeStableAnalysis([20000, 50000]);
    const out = readyEngine({ multiNotePolicy: 'SINGLE_ONLY' }).handle(frame(withStability({ stable: true, agree: 5, window: 5, consensus: two.detections }), 0));
    expect(out).toMatchObject({ status: 'MULTI_NOT_ALLOWED', result: null });
  });
});