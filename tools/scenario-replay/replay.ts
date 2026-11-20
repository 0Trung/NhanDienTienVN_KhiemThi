// Phát lại một kịch bản qua FrameAnalyzer + DecisionEngine với đồng hồ giả; ghi lại mọi lần công bố.
// Chỉ phát thẳng InferenceResult giả vào analyzer (bỏ qua camera, mô hình, giọng nói thật).
import type {
  AppConfig, DecisionInput, Denomination, IDecisionEngine, IFrameAnalyzer, SystemEvent,
} from '../../src/contracts';
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import { createFakeClock } from '../../src/utils/time';
import { deriveGeneratorOptions, generateFrames } from './scenario';
import type { Scenario } from './scenario';

/** Hạt giống mặc định của lần phát lại. */
export const DEFAULT_SEED = 1;
/** Thời lượng giả của một câu đọc kết quả, mili-giây: hết thời gian này thì gửi RESULT_SPEECH_ENDED. */
export const DEFAULT_SPEECH_DURATION_MS = 2000;

/** Chuỗi sự kiện khởi động đưa engine tới READY (giống tests/decision/harness). */
const BOOT_EVENTS: readonly SystemEvent[] = ['APP_STARTED', 'GESTURE_UNLOCKED', 'PERMISSION_REQUESTED', 'MODEL_READY', 'CAMERA_READY'];

/** Hai nhà máy của module thật, được tiêm vào để test thay bằng đồ giả được. */
export interface ReplayDeps {
  createFrameAnalyzer(config: AppConfig): IFrameAnalyzer;
  createDecisionEngine(config: AppConfig['decision']): IDecisionEngine;
}

export interface ReplayOptions {
  config?: AppConfig;
  seed?: number;
  speechDurationMs?: number;
}

/** Một lần công bố tổng tiền của engine, kèm sự thật tại khung đó. */
export interface PublicationRecord {
  slot: number;
  frameId: number;
  atMs: number;
  denominations: Denomination[];
  total: number;
  /** Sự thật tại khung công bố; null = không có tiền. */
  truth: readonly Denomination[] | null;
  truthTotal: number | null;
  /** Đúng khi có tiền và tổng công bố = tổng sự thật. Đây là tiêu chí Unsafe Read. */
  correct: boolean;
  /** Đúng cả tập mệnh giá (cùng dãy trái → phải). correct nhưng không exactSet là tổng đúng, tập sai. */
  exactSet: boolean;
  /** Mã lý do của engine, để chẩn đoán. */
  reasons: string[];
  /** Số khung đồng thuận mà analyzer báo lúc công bố. */
  agree: number;
  /** Số tờ analyzer thấy ở khung đó. */
  detectedCount: number;
}

/** Một khe thời gian đã phát lại. */
export interface FrameRecord {
  slot: number;
  frameId: number;
  atMs: number;
  dropped: boolean;
  /** Có tiền thật trong cảnh ở khe này (truth khác null). */
  moneyPresent: boolean;
  /** Engine nói một câu hướng dẫn ở khung này. */
  guidance: boolean;
}

export interface ReplayOutcome {
  scenarioId: string;
  seed: number;
  frames: FrameRecord[];
  publications: PublicationRecord[];
}

const sumOf = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0);
const sameSequence = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Phát lại kịch bản. XÁC ĐỊNH: cùng (scenario, seed, config, deps) cho cùng kết quả.
 * Giọng nói giả: khi engine công bố, câu đọc kéo dài speechDurationMs rồi RESULT_SPEECH_ENDED được gửi
 * trước khung đầu tiên có mốc ≥ thời điểm kết thúc. Trong lúc "đang nói" engine bỏ qua khung (đúng như app thật).
 */
export function replayScenario(scenario: Scenario, deps: ReplayDeps, options: ReplayOptions = {}): ReplayOutcome {
  const config = options.config ?? DEFAULT_CONFIG;
  const seed = options.seed ?? DEFAULT_SEED;
  const speechMs = options.speechDurationMs ?? DEFAULT_SPEECH_DURATION_MS;
  const frames = generateFrames(scenario, seed, deriveGeneratorOptions(config));

  const clock = createFakeClock(0);
  const analyzer = deps.createFrameAnalyzer(config);
  const engine = deps.createDecisionEngine(config.decision);
  for (const event of BOOT_EVENTS) engine.handle({ type: 'SYSTEM', event, now: clock.now() });

  const records: FrameRecord[] = [];
  const publications: PublicationRecord[] = [];
  let speechEndsAt: number | null = null;

  for (const f of frames) {
    clock.advance(Math.max(0, f.atMs - clock.now()));
    if (speechEndsAt !== null && clock.now() >= speechEndsAt) {
      engine.handle({ type: 'SYSTEM', event: 'RESULT_SPEECH_ENDED', now: speechEndsAt });
      speechEndsAt = null;
    }
    const base = { slot: f.slot, frameId: f.frameId, atMs: f.atMs, dropped: f.dropped, moneyPresent: f.truth !== null };
    if (f.result === null) {
      records.push({ ...base, guidance: false });
      continue;
    }
    const analysis = analyzer.analyze(f.result);
    const input: DecisionInput = { type: 'ANALYSIS', analysis, now: clock.now() };
    const out = engine.handle(input);
    records.push({ ...base, guidance: out.speech?.kind === 'GUIDANCE' });

    if (out.result !== null) {
      const truthTotal = f.truth === null ? null : sumOf(f.truth);
      publications.push({
        slot: f.slot,
        frameId: f.frameId,
        atMs: f.atMs,
        denominations: [...out.result.denominations],
        total: out.result.total,
        truth: f.truth,
        truthTotal,
        correct: truthTotal !== null && out.result.total === truthTotal,
        exactSet: f.truth !== null && sameSequence(out.result.denominations, f.truth),
        reasons: [...out.reasons],
        agree: analysis.stability.agree,
        detectedCount: analysis.detections.length,
      });
      speechEndsAt = clock.now() + speechMs;
    }
  }
  return { scenarioId: scenario.id, seed, frames: records, publications };
}