// Đồ dùng chung cho test của tools/ (không phải file test).
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import type { DecisionInput, DecisionOutput, Denomination, RecognitionResult } from '../../src/contracts';
import { SINGLE_BOX } from '../../tools/scenario-replay/scenarios/shared';
import type { ReplayDeps } from '../../tools/scenario-replay/replay';
import { deriveGeneratorOptions } from '../../tools/scenario-replay/scenario';
import type { GenerationSpec, Scenario, SyntheticFrame } from '../../tools/scenario-replay/scenario';
import { makeAnalysis } from '../fakes/factories';

export const OPTIONS = deriveGeneratorOptions(DEFAULT_CONFIG);

/** Kịch bản tối thiểu cho test: một tờ 20.000 (hoặc theo tham số). */
export function scenarioOf(
  generation: GenerationSpec,
  overrides: Partial<Omit<Scenario, 'generation'>> = {},
): Scenario {
  return {
    id: 'test-scenario', name: 'Kịch bản thử', groundTruth: [20000], expectation: 'PUBLISH',
    knownLimitation: false, notes: '', ...overrides, generation,
  };
}

/** Một tờ 20.000 chắc chắn trong `frames` khung, với nhiễu tuỳ chọn. */
export const oneNote = (frames: number, noise: GenerationSpec['noise'] = {}): GenerationSpec => ({
  phases: [{ frames, objects: [{ denomination: 20000, box: SINGLE_BOX, confidence: 0.9 }] }],
  noise,
});

/** Dấu vân tay của dãy khung (bỏ ảnh xám dùng chung), để so sánh hai lần sinh. */
export const fingerprint = (frames: readonly SyntheticFrame[]): string =>
  JSON.stringify(frames.map((f) => ({
    slot: f.slot, dropped: f.dropped, quality: f.quality, truth: f.truth, detections: f.result?.detections ?? null,
  })));

export const recognition = (total: number, denominations: Denomination[], now: number): RecognitionResult => ({
  status: denominations.length === 1 ? 'CONFIDENT_SINGLE' : 'CONFIDENT_MULTI',
  count: denominations.length, denominations, total, formattedTotal: `${total} đồng`, timestamp: now,
});

/**
 * Đồ giả của hai module thật: analyzer trả khung trống, engine ghi lại mọi đầu vào và công bố theo kịch bản.
 * `publish(n, now)` được gọi ở lần ANALYSIS thứ n (từ 0, đếm RIÊNG cho từng engine được tạo, tức từng lần phát lại);
 * trả RecognitionResult để công bố hoặc null để im lặng. `inputs` gom đầu vào của mọi engine theo thứ tự nhận.
 */
export function fakeDeps(publish: (n: number, now: number) => RecognitionResult | null): { deps: ReplayDeps; inputs: DecisionInput[] } {
  const inputs: DecisionInput[] = [];
  const deps: ReplayDeps = {
    createFrameAnalyzer: () => ({ analyze: (r) => makeAnalysis({ meta: r.meta }), reset: () => undefined }),
    createDecisionEngine: () => {
      let analyses = 0;
      return {
        state: 'READY',
        lastResult: null,
        reset: () => undefined,
        handle(input): DecisionOutput {
          inputs.push(input);
          const result = input.type === 'ANALYSIS' ? publish(analyses++, input.now) : null;
          return { state: 'DETECTING', status: null, reasons: ['FAKE'], speech: null, result, shouldCalculateTotal: result !== null };
        },
      };
    },
  };
  return { deps, inputs };
}