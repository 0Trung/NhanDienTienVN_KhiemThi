// Nối công cụ với module thật theo bảng đăng ký xuất khẩu (P06, P07). Chỉ được import SAU khi stub-guard đã cho qua.
import { createFrameAnalyzer } from '../../src/analyzer/frame-analyzer';
import { createDecisionEngine } from '../../src/decision/decision-engine';
import type { ReplayDeps } from './replay';

export const realDeps: ReplayDeps = { createFrameAnalyzer, createDecisionEngine };