/**
 * Adapter DUY NHẤT gọi plugin @capacitor/app (vòng đời app và nút Back của Android), đứng sau AppLifecyclePort
 * để app.ts và test chạy được trong Node.
 * - Lắng nghe CẢ visibilitychange của document LẪN appStateChange của plugin: trên Android hai nguồn có thể báo
 *   trùng (trên web plugin tự phát appStateChange từ visibilitychange). Việc chống trùng là của app.ts.
 * - Mọi lời gọi plugin bọc try/catch; thiếu plugin hay chạy trên web thì không làm gì (dự phòng web).
 * - Đăng ký listener của plugin là bất đồng bộ: hàm gỡ trả về dùng được cả khi lời hứa chưa xong.
 */
import { App } from '@capacitor/app';
import type { AppPlugin } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { createLogger } from '../utils/logger';
import type { AppLifecyclePort } from './app';

const log = createLogger('app-lifecycle');

/** Phần của plugin mà adapter dùng (tiêm đồ giả khi test). */
export type AppPluginLike = Pick<AppPlugin, 'addListener' | 'minimizeApp'>;

/** Phần của document mà adapter dùng. */
export interface LifecycleDocument {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface LifecycleEnv {
  /** Bỏ trống: dùng document thật nếu có; null: không nghe visibilitychange. */
  doc?: LifecycleDocument | null;
  /** Bỏ trống: dùng plugin App thật; null: không có plugin. */
  plugin?: AppPluginLike | null;
}

/** Đăng ký một listener bất đồng bộ của plugin; hàm gỡ gỡ được ngay cả khi lời hứa đăng ký chưa xong. */
function subscribe(register: () => Promise<PluginListenerHandle>, what: string): () => void {
  let removed = false;
  let handle: PluginListenerHandle | null = null;
  const drop = (h: PluginListenerHandle): void => {
    Promise.resolve(h.remove()).catch((e: unknown) => log.debug(`Gỡ listener ${what} lỗi`, e));
  };
  try {
    Promise.resolve(register()).then(
      (h) => {
        if (removed) drop(h);
        else handle = h;
      },
      (e: unknown) => log.warn(`Không đăng ký được listener ${what}`, e),
    );
  } catch (e) {
    log.warn(`Không đăng ký được listener ${what}`, e);
  }
  return () => {
    removed = true;
    if (handle !== null) drop(handle);
    handle = null;
  };
}

export function createAppLifecyclePort(env: LifecycleEnv = {}): AppLifecyclePort {
  const doc = env.doc === undefined ? (typeof document === 'undefined' ? null : document) : env.doc;
  const plugin = env.plugin === undefined ? App : env.plugin;

  return {
    onVisibilityChange(handler: (visible: boolean) => void): () => void {
      const offs: Array<() => void> = [];
      if (doc !== null) {
        const listener = (): void => handler(doc.visibilityState !== 'hidden');
        doc.addEventListener('visibilitychange', listener);
        offs.push(() => doc.removeEventListener('visibilitychange', listener));
      }
      if (plugin !== null) offs.push(subscribe(() => plugin.addListener('appStateChange', (s) => handler(s.isActive)), 'appStateChange'));
      return () => {
        for (const off of offs) off();
      };
    },

    onBackButton(handler: () => void): () => void {
      if (plugin === null) return () => undefined;
      return subscribe(() => plugin.addListener('backButton', () => handler()), 'backButton');
    },

    async minimize(): Promise<void> {
      if (plugin === null) return;
      try {
        await plugin.minimizeApp();
      } catch (e) {
        log.debug('minimizeApp không dùng được (không phải Android?)', e);
      }
    },
  };
}