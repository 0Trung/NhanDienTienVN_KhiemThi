// STUB P05 — module thật sẽ GHI ĐÈ file này.
import type { AppConfig, IInferenceClient } from '../contracts';

export function createInferenceClient(
  o: { modelBaseUrl: string; ortBaseUrl: string; config: AppConfig['inference']; workerFactory?: () => Worker },
): IInferenceClient {
  throw new Error('STUB: createInferenceClient chưa được cài (P05)');
}