import { beforeAll, describe, expect, it } from 'vitest';
import { DENOMINATIONS } from '../../src/contracts';
import { ALL_SCENARIOS } from '../../tools/scenario-replay/scenarios';
import { designGoalMet, runSweep } from '../../tools/scenario-replay/suite';
import type { SweepResult } from '../../tools/scenario-replay/suite';
import { fakeDeps, oneNote, recognition, scenarioOf } from './helpers';
import { REAL_MODULES_READY } from './real-modules';

/** Engine giả luôn công bố 50.000 đồng ở khung đầu tiên của mỗi lần phát lại. */
const announce50k = () => fakeDeps((n, now) => (n === 0 ? recognition(50000, [50000], now) : null)).deps;
const silent = () => fakeDeps(() => null).deps;

/** Kịch bản thường mà sự thật là 50.000: lần công bố giả là ĐÚNG. */
const normalOk = scenarioOf(oneNote(10), { id: 'normal-ok', groundTruth: [50000] });
/** Kịch bản thường mà sự thật là 20.000: lần công bố giả là SAI. */
const normalBad = scenarioOf(oneNote(10), { id: 'normal-bad', groundTruth: [20000] });
/** Hạn chế đã biết, sự thật 20.000: lần công bố giả là SAI nhưng phải được tính riêng. */
const knownMiss = scenarioOf(oneNote(10), { id: 'known-miss', groundTruth: [20000], knownLimitation: true });

describe('runSweep · hạn chế đã biết được tính riêng', () => {
  it('lần đọc sai của hạn chế đã biết không vào nhóm chính nhưng có ở nhóm riêng', () => {
    const sweep = runSweep([normalOk, knownMiss], announce50k());
    expect(sweep.main).toMatchObject({ scenarios: 1, publications: 1, unsafeReads: 0 });
    expect(sweep.known).toMatchObject({ scenarios: 1, publications: 1, unsafeReads: 1 });
    expect(sweep.mainUnsafe).toEqual([]);
  });

  it('mục tiêu thiết kế đạt khi chỉ hạn chế đã biết đọc sai', () => {
    expect(designGoalMet(runSweep([normalOk, knownMiss], announce50k()))).toBe(true);
  });

  it('một lần đọc sai ở kịch bản thường làm mục tiêu thiết kế không đạt và được liệt kê đủ chi tiết', () => {
    const sweep = runSweep([normalOk, normalBad, knownMiss], announce50k());
    expect(designGoalMet(sweep)).toBe(false);
    expect(sweep.main.unsafeReads).toBe(1);
    expect(sweep.mainUnsafe).toHaveLength(1);
    expect(sweep.mainUnsafe[0]).toMatchObject({ scenarioId: 'normal-bad', seed: 1, frameId: 1, announcedTotal: 50000, truthTotal: 20000 });
  });

  it('không công bố gì thì không được coi là đạt (từ chối tất cả là vô nghĩa)', () => {
    const sweep = runSweep([normalOk], silent());
    expect(sweep.mainUnsafe).toEqual([]);
    expect(designGoalMet(sweep)).toBe(false);
  });
});

describe('runSweep · nhiều seed', () => {
  it('quét seed liên tiếp từ seed đầu và cộng dồn mọi seed', () => {
    const sweep = runSweep([normalOk, knownMiss], announce50k(), { seed: 10, seedCount: 3 });
    expect(sweep.seeds).toEqual([10, 11, 12]);
    expect(sweep.perSeed).toHaveLength(3);
    expect(sweep.perSeed.map((list) => list[0]?.seed)).toEqual([10, 11, 12]);
    expect(sweep.main.scenarios).toBe(3);
    expect(sweep.known.unsafeReads).toBe(3);
  });

  it.each([0, -1, 1.5, Number.NaN])('seedCount = %s bị từ chối bằng RangeError', (seedCount) => {
    expect(() => runSweep([normalOk], silent(), { seedCount })).toThrow(RangeError);
  });
});

describe('ALL_SCENARIOS · danh mục kịch bản', () => {
  it('có ít nhất 14 kịch bản, mã không trùng', () => {
    expect(ALL_SCENARIOS.length).toBeGreaterThanOrEqual(14);
    expect(new Set(ALL_SCENARIOS.map((s) => s.id)).size).toBe(ALL_SCENARIOS.length);
  });

  it('mỗi mệnh giá có một kịch bản một tờ ổn định', () => {
    for (const d of DENOMINATIONS) {
      const scenario = ALL_SCENARIOS.find((s) => s.id === `single-${d}`);
      expect(scenario?.groundTruth).toEqual([d]);
      expect(scenario?.expectation).toBe('PUBLISH');
    }
  });

  it('chỉ đúng một hạn chế đã biết: ba tờ nhưng mô hình chỉ thấy hai', () => {
    expect(ALL_SCENARIOS.filter((s) => s.knownLimitation).map((s) => s.id)).toEqual(['three-notes-seen-as-two']);
  });

  it('không có tiền thì kỳ vọng từ chối; kỳ vọng đọc thì phải có sự thật', () => {
    for (const s of ALL_SCENARIOS) {
      if (s.groundTruth === null) expect(s.expectation, s.id).toBe('REJECT');
      if (s.expectation === 'PUBLISH') expect(s.groundTruth, s.id).not.toBeNull();
    }
  });

  it('mọi kịch bản có ghi chú và ít nhất một khung', () => {
    for (const s of ALL_SCENARIOS) {
      expect(s.notes, s.id).not.toBe('');
      expect(s.generation.phases.reduce((sum, p) => sum + p.frames, 0), s.id).toBeGreaterThan(0);
    }
  });
});

/** Số seed quét trong test tích hợp: đủ để bắt lỗi hiếm do nhiễu mà vẫn chạy trong vài giây. */
const INTEGRATION_SEEDS = 20;

describe.skipIf(!REAL_MODULES_READY)('bộ kịch bản mặc định trên module thật (mục tiêu thiết kế)', () => {
  // Quét một lần, dùng cho mọi test bên dưới (mỗi lần quét tốn vài giây).
  let sweep: SweepResult;
  beforeAll(async () => {
    const { realDeps } = await import('../../tools/scenario-replay/real-deps');
    sweep = runSweep(ALL_SCENARIOS, realDeps, { seedCount: INTEGRATION_SEEDS });
  });

  it('Unsafe Read Rate nhóm chính = 0 với cấu hình mặc định, trên nhiều seed', () => {
    expect(sweep.mainUnsafe).toEqual([]);
    expect(sweep.main.unsafeReads).toBe(0);
    expect(sweep.main.publications).toBeGreaterThan(0);
    expect(designGoalMet(sweep)).toBe(true);
  });

  it('hạn chế đã biết vẫn tái hiện và được báo riêng (không bị giấu)', () => {
    expect(sweep.known.publications).toBe(INTEGRATION_SEEDS);
    expect(sweep.known.unsafeReads).toBe(INTEGRATION_SEEDS);
  });

  it('hệ thống không "an toàn nhờ im lặng": đọc đúng mọi ca cần đọc, từ chối đúng mọi ca cần từ chối, không đọc lặp', () => {
    expect(sweep.main.readSuccessRate.value).toBe(1);
    expect(sweep.main.rejectionRate.value).toBe(1);
    expect(sweep.main.repeatedReads).toBe(0);
  });

  it.each([
    { id: 'note-replaced-in-place', publications: 2 },
    { id: 'single-leaves-and-returns', publications: 2 },
    { id: 'money-flicker', publications: 1 },
    { id: 'single-20000-noisy', publications: 1 },
  ])('$id công bố đúng $publications lần, mỗi lần đúng và không lặp', ({ id, publications }) => {
    const m = sweep.perSeed[0]?.find((x) => x.scenarioId === id);
    expect(m).toMatchObject({ publications, correctReads: publications, unsafeReads: 0, repeatedReads: 0 });
  });
});