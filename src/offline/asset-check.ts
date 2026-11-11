// STUB P09 — module thật sẽ GHI ĐÈ file này.
import type { AppError } from '../contracts';

export function checkBundledAssets(
  o: { baseUrl: string; fetchFn?: typeof fetch },
): Promise<{ ok: boolean; missing: string[]; warnings: string[]; error?: AppError }> {
  throw new Error('STUB: checkBundledAssets chưa được cài (P09)');
}