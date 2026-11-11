// STUB P10 — module thật sẽ GHI ĐÈ file này.
import type { ISettingsStore, SettingAck, Settings } from '../contracts';

export function createSettingsManager(
  store: ISettingsStore,
  onAck: (a: SettingAck) => void,
): {
  load(): Promise<Settings>;
  get(): Settings;
  set(p: Partial<Settings>): Promise<Settings>;
  subscribe(h: (s: Settings) => void): () => void;
} {
  throw new Error('STUB: createSettingsManager chưa được cài (P10)');
}