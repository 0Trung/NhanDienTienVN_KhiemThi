// Môi trường node (không có DOM): logic không chạm DOM vẫn phải chạy được.
import { describe, expect, it, vi } from 'vitest';
import { createAriaLiveEngine } from '../../src/accessibility/aria-live-engine';
import { createSettingsManager } from '../../src/accessibility/settings-manager';
import type { SettingAck } from '../../src/contracts';
import { MemorySettingsStore } from '../fakes';

describe('không có DOM', () => {
  it('aria-live-engine: available false; speak báo TTS_UNAVAILABLE qua onError, không báo onStart', async () => {
    const engine = createAriaLiveEngine();
    expect(await engine.init()).toEqual({ available: false, vietnameseVoice: true, offlineVietnamese: true, requiresUserGesture: false });
    const hooks = { onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
    engine.speak('Xin chào', { rate: 1, lang: 'vi-VN' }, hooks);
    expect(hooks.onStart).not.toHaveBeenCalled();
    expect(hooks.onError.mock.calls[0]?.[0]).toMatchObject({ code: 'TTS_UNAVAILABLE' });
  });

  it('settings-manager: vẫn nạp, đổi, lưu và phát ack mà không cần DOM', async () => {
    const store = new MemorySettingsStore();
    const acks: SettingAck[] = [];
    const manager = createSettingsManager(store, (a) => acks.push(a));
    await manager.load();
    await manager.set({ vibrationEnabled: false });
    expect([manager.get().vibrationEnabled, store.snapshot.vibrationEnabled, acks]).toEqual([false, false, ['VIBRATION_OFF']]);
  });
});