// STUB P10 — module thật sẽ GHI ĐÈ file này.
import type { Settings } from '../contracts';

/** Khai báo tối thiểu của stub; P10 định nghĩa kiểu thật. */
export interface SettingsItem { id: string; label: string }

export function buildSettingsViewModel(
  get: () => Settings,
  set: (p: Partial<Settings>) => Promise<Settings>,
): SettingsItem[] {
  throw new Error('STUB: buildSettingsViewModel chưa được cài (P10)');
}