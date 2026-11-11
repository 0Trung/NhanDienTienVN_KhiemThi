// STUB P05 — module thật sẽ GHI ĐÈ file này.
import type { CapturedFrame, IInferenceClient } from '../contracts';

export interface Stats { mean: number; p50: number; p95: number }

export function runBenchmark(
  client: IInferenceClient,
  makeFrame: () => Promise<CapturedFrame>,
  n: number,
): Promise<{ totalMs: Stats; inferMs: Stats }> {
  throw new Error('STUB: runBenchmark chưa được cài (P05)');
}