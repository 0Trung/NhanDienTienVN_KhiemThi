import type { HapticEvent, IHaptics } from '../contracts';
import { createLogger } from '../utils/logger';
import { getPlatform } from '../utils/platform';
import { createCapacitorHapticPort } from './haptics-adapter';

const log = createLogger('haptics');

/** Mẫu rung theo quy ước Web Vibration API: [rung, nghỉ, rung, nghỉ, ...], đơn vị mili-giây. */
export const HAPTIC_PATTERNS: Readonly<Record<HapticEvent, readonly number[]>> = {
  START: [30],
  SUCCESS: [40, 60, 40],
  UNCERTAIN: [300],
  ERROR: [100, 80, 100, 80, 300],
};

/**
 * Cổng nhỏ che plugin rung native. Plugin chỉ nhận MỘT khoảng rung liên tục,
 * nên chuỗi nhiều nhịp do HapticService phát bằng hẹn giờ.
 * Bản triển khai thật không được ném lỗi: không rung được thì trả false.
 */
export interface HapticPort {
  vibrate(durationMs: number): Promise<boolean>;
}

/** Hàm rung của trình duyệt (navigator.vibrate): nhận cả mẫu và tự hủy mẫu đang chạy. */
export type WebVibrate = (pattern: number[]) => boolean;

/** Hẹn giờ được tiêm vào để test không phải chờ thật. */
export interface HapticTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HapticServiceDeps {
  isEnabled: () => boolean;
  /** Cổng plugin native; bỏ trống hoặc null nếu không chạy trong APK. */
  port?: HapticPort | null;
  /** Dự phòng trình duyệt; bỏ trống hoặc null nếu không có navigator.vibrate. */
  webVibrate?: WebVibrate | null;
  timers?: HapticTimers;
}

const REAL_TIMERS: HapticTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

/** Gọi cổng rung và gom MỌI kiểu thất bại (trả false, từ chối, ném đồng bộ) về false. */
async function deliver(port: HapticPort, durationMs: number): Promise<boolean> {
  try {
    return (await port.vibrate(durationMs)) !== false;
  } catch {
    return false;
  }
}

/**
 * Bộ rung với các thành phần được tiêm vào (dùng cho test và cho createHaptics).
 * - Native: phát từng nhịp qua port bằng hẹn giờ; chuỗi mới hủy chuỗi cũ còn chờ.
 * - Không native hoặc plugin lỗi: dùng navigator.vibrate nếu có.
 * - Không có cả hai: supported = false và play không làm gì.
 * - Cài đặt tắt rung được kiểm tra ở mọi nhịp, kể cả giữa chừng một chuỗi.
 */
export function createHapticService(deps: HapticServiceDeps): IHaptics {
  const port = deps.port ?? null;
  const webVibrate = deps.webVibrate ?? null;
  const timers = deps.timers ?? REAL_TIMERS;
  let portFailed = false;
  let generation = 0;
  let pending: unknown[] = [];

  function enabled(): boolean {
    try {
      return deps.isEnabled();
    } catch (e) {
      log.warn('isEnabled ném lỗi, coi như đã tắt rung', e);
      return false;
    }
  }

  function cancelPending(): void {
    for (const handle of pending) timers.clearTimeout(handle);
    pending = [];
  }

  function playWeb(pattern: readonly number[]): void {
    if (webVibrate === null) return;
    try {
      webVibrate([...pattern]);
    } catch (e) {
      log.warn('navigator.vibrate lỗi', e);
    }
  }

  function onPortFailure(pattern: readonly number[], index: number, gen: number): void {
    if (!portFailed) log.warn('Plugin rung native lỗi, chuyển sang navigator.vibrate nếu có');
    portFailed = true;
    if (gen !== generation) return; // chuỗi này đã bị thay, không được chạm vào chuỗi mới
    cancelPending();
    playWeb(pattern.slice(index)); // rung nốt phần còn lại của chuỗi bằng trình duyệt
  }

  function pulse(activePort: HapticPort, pattern: readonly number[], index: number, gen: number): void {
    if (gen !== generation) return;
    if (!enabled()) {
      cancelPending();
      return;
    }
    const duration = pattern[index];
    if (duration === undefined) return;
    void deliver(activePort, duration).then((ok) => {
      if (!ok) onPortFailure(pattern, index, gen);
    });
  }

  function playNative(activePort: HapticPort, pattern: readonly number[], gen: number): void {
    let offset = 0;
    for (let index = 0; index < pattern.length; index += 2) {
      if (offset === 0) {
        pulse(activePort, pattern, index, gen);
      } else {
        pending.push(timers.setTimeout(() => pulse(activePort, pattern, index, gen), offset));
      }
      offset += (pattern[index] ?? 0) + (pattern[index + 1] ?? 0);
    }
  }

  function play(e: HapticEvent): void {
    if (!enabled()) return;
    const pattern = HAPTIC_PATTERNS[e];
    if (pattern === undefined) return;
    cancelPending();
    generation += 1;
    if (port !== null && !portFailed) playNative(port, pattern, generation);
    else playWeb(pattern);
  }

  return {
    get supported(): boolean {
      return (port !== null && !portFailed) || webVibrate !== null;
    },
    play,
  };
}

function detectWebVibrate(): WebVibrate | null {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return null;
    return (pattern) => navigator.vibrate(pattern);
  } catch {
    return null;
  }
}

/**
 * Bộ rung thật. Trong APK (android-native) dùng @capacitor/haptics qua adapter;
 * ngoài APK dùng navigator.vibrate nếu trình duyệt có.
 * isEnabled thường là () => settings.vibrationEnabled.
 */
export function createHaptics(o: { isEnabled: () => boolean }): IHaptics {
  return createHapticService({
    isEnabled: o.isEnabled,
    port: getPlatform() === 'android-native' ? createCapacitorHapticPort() : null,
    webVibrate: detectWebVibrate(),
  });
}