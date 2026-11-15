import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRecentLogs, setLogSink } from '../../src/utils/logger';
import { createCapacitorHapticPort } from '../../src/voice/haptics-adapter';
import type { HapticsPluginLike } from '../../src/voice/haptics-adapter';

beforeEach(() => {
  setLogSink(() => undefined);
});

afterEach(() => {
  setLogSink(null);
  clearRecentLogs();
});

describe('createCapacitorHapticPort', () => {
  it('gọi plugin với { duration } và trả true khi thành công', async () => {
    const received: Array<{ duration: number }> = [];
    const plugin: HapticsPluginLike = {
      vibrate: (options) => {
        received.push(options);
        return Promise.resolve();
      },
    };
    expect(await createCapacitorHapticPort(plugin).vibrate(250)).toBe(true);
    expect(received).toEqual([{ duration: 250 }]);
  });

  it.each([
    {
      label: 'plugin từ chối',
      plugin: { vibrate: () => Promise.reject(new Error('không có quyền VIBRATE')) } satisfies HapticsPluginLike,
    },
    {
      label: 'plugin ném đồng bộ',
      plugin: {
        vibrate: (): Promise<void> => {
          throw new Error('chưa đăng ký plugin');
        },
      } satisfies HapticsPluginLike,
    },
  ])('$label → trả false, không ném lỗi', async ({ plugin }) => {
    expect(await createCapacitorHapticPort(plugin).vibrate(100)).toBe(false);
  });
});