import { DEFAULT_SETTINGS } from '../../src/config/app-config';
import type { AppError, ISettingsStore, Settings } from '../../src/contracts';

/**
 * Kho cài đặt trong bộ nhớ. Luôn trả bản sao.
 * Đặt `failWith` (ví dụ AppError STORAGE_FAILED) để cả load, save và reset ném lỗi đó.
 */
export class MemorySettingsStore implements ISettingsStore {
  loadCalls = 0;
  saveCalls = 0;
  resetCalls = 0;
  failWith: AppError | null = null;

  private state: Settings;

  constructor(initial: Partial<Settings> = {}) {
    this.state = { ...DEFAULT_SETTINGS, ...initial };
  }

  /** Bản sao trạng thái hiện tại, không tính là một lần load. */
  get snapshot(): Settings {
    return { ...this.state };
  }

  async load(): Promise<Settings> {
    this.loadCalls += 1;
    if (this.failWith) throw this.failWith;
    return { ...this.state };
  }

  async save(patch: Partial<Settings>): Promise<Settings> {
    this.saveCalls += 1;
    if (this.failWith) throw this.failWith;
    this.state = { ...this.state, ...patch };
    return { ...this.state };
  }

  async reset(): Promise<Settings> {
    this.resetCalls += 1;
    if (this.failWith) throw this.failWith;
    this.state = { ...DEFAULT_SETTINGS };
    return { ...this.state };
  }
}