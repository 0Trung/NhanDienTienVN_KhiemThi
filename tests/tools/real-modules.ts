// Cho biết FrameAnalyzer và DecisionEngine thật đã được ghép chưa (không còn "// STUB"), để test tích hợp tự bỏ qua trên repo chỉ có P00.
import { GUARDED_SOURCES, checkImplemented } from '../../tools/scenario-replay/stub-guard';

const sources = import.meta.glob<string>(['../../src/analyzer/frame-analyzer.ts', '../../src/decision/decision-engine.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const REAL_MODULES_READY: boolean =
  checkImplemented(GUARDED_SOURCES.map((s) => ({ file: s.file, text: sources[`../../${s.file}`] ?? null }))).length === 0;