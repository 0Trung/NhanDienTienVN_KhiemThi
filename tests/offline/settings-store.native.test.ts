import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsStore } from '../../src/offline/settings-store';
import { setLogSink } from '../../src/utils/logger';

vi.mock('../../src/utils/platform', () => ({ getPlatform: () => 'android-native', isNative: () => true }));

describe('createSettingsStore trong APK (android-native)', () => {
  beforeEach(() => setLogSink(() => undefined));
  afterEach(() => setLogSink(null));

  it('plugin Preferences lỗi (Node không có WebView) thì rơi về dự phòng, app không sập', async () => {
    const store = createSettingsStore();
    await store.save({ torchEnabled: true });
    expect((await store.load()).torchEnabled).toBe(true);
    await store.reset();
  });
});