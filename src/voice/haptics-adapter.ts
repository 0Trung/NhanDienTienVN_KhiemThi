// FILE ADAPTER DUY NHẤT gọi plugin @capacitor/haptics. Mọi nơi khác đi qua HapticPort.
import { Haptics } from '@capacitor/haptics';
import { createLogger } from '../utils/logger';
import type { HapticPort } from './haptic-service';

const log = createLogger('haptics-adapter');

/** Phần của plugin mà adapter dùng; tách ra để test bằng đồ giả mà không cần plugin thật. */
export interface HapticsPluginLike {
  vibrate(options: { duration: number }): Promise<void>;
}

/**
 * Cổng rung dựa trên @capacitor/haptics. Mỗi lần gọi rung MỘT khoảng liên tục durationMs.
 * Không bao giờ ném lỗi: plugin lỗi (đồng bộ hay bất đồng bộ) thì ghi log và trả false.
 */
export function createCapacitorHapticPort(plugin: HapticsPluginLike = Haptics): HapticPort {
  return {
    async vibrate(durationMs: number): Promise<boolean> {
      try {
        await plugin.vibrate({ duration: durationMs });
        return true;
      } catch (e) {
        log.warn('Haptics.vibrate lỗi', e);
        return false;
      }
    },
  };
}