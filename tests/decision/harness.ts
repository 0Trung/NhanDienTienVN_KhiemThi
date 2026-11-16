// Đồ dùng chung cho test kịch bản và test tính chất của DecisionEngine (không phải file test).
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import type { AppConfig, DecisionInput, DecisionOutput, FrameAnalysis, IDecisionEngine, SystemEvent } from '../../src/contracts';
import { createDecisionEngine } from '../../src/decision/decision-engine';

export type DecisionConfig = AppConfig['decision'];

/** Chu kỳ một khung hình giả (khoảng 3 fps). */
export const FRAME_MS = 300;

/** Cấu hình mặc định, thay từng trường bằng `patch`. */
export const cfg = (patch: Partial<DecisionConfig> = {}): DecisionConfig => ({ ...DEFAULT_CONFIG.decision, ...patch });

export const sys = (event: SystemEvent, now = 0): DecisionInput => ({ type: 'SYSTEM', event, now });
export const frame = (analysis: FrameAnalysis, now: number): DecisionInput => ({ type: 'ANALYSIS', analysis, now });

const BOOT: SystemEvent[] = ['APP_STARTED', 'GESTURE_UNLOCKED', 'PERMISSION_REQUESTED', 'MODEL_READY', 'CAMERA_READY'];

/** Engine đã khởi động xong (READY). */
export function readyEngine(patch: Partial<DecisionConfig> = {}): IDecisionEngine {
  const engine = createDecisionEngine(cfg(patch));
  for (const event of BOOT) engine.handle(sys(event));
  return engine;
}

/** Đưa `count` khung liên tiếp, khung thứ i ở thời điểm start + i * FRAME_MS; trả các đầu ra theo thứ tự. */
export function feed(
  engine: IDecisionEngine,
  analysis: FrameAnalysis | ((i: number) => FrameAnalysis),
  count: number,
  start = 0,
): DecisionOutput[] {
  return Array.from({ length: count }, (_, i) =>
    engine.handle(frame(typeof analysis === 'function' ? analysis(i) : analysis, start + i * FRAME_MS)),
  );
}