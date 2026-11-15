import { AppError } from '../contracts';

/**
 * Cổng khóa–giá trị nhỏ nhất mà kho cài đặt cần.
 * Quy ước: mọi lỗi của nơi lưu phải nổi lên dưới dạng AppError STORAGE_FAILED
 * để kho cài đặt biết đường rơi về bản dự phòng.
 */
export interface KeyValuePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Phần của plugin Preferences mà adapter dùng: get/set/remove nhận một đối tượng tùy chọn, get trả { value }. */
export interface PreferencesLike {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

/** Phần của Storage (localStorage) mà adapter dùng. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type Action = 'đọc' | 'lưu' | 'xóa';

/** Chạy một thao tác lưu trữ; mọi lỗi (kể cả ném đồng bộ) được gói thành AppError STORAGE_FAILED. */
async function guard<T>(action: Action, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new AppError('STORAGE_FAILED', `Không ${action} được cài đặt.`, false, e);
  }
}

/** Bản trong bộ nhớ: không bao giờ lỗi, mất khi app tắt. */
export function createMemoryPort(): KeyValuePort {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}

/** localStorage của WebView; null khi không có hoặc bị chặn (truy cập có thể ném SecurityError). */
export function getLocalStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Bản localStorage. `storage` null thì mọi thao tác đều lỗi STORAGE_FAILED (để rơi về bản kế tiếp). */
export function createLocalStoragePort(storage: StorageLike | null = getLocalStorage()): KeyValuePort {
  const need = (): StorageLike => {
    if (!storage) throw new Error('localStorage không dùng được');
    return storage;
  };
  return {
    get: (key) => guard('đọc', () => need().getItem(key)),
    set: (key, value) => guard('lưu', () => need().setItem(key, value)),
    remove: (key) => guard('xóa', () => need().removeItem(key)),
  };
}

/**
 * Nạp plugin Preferences. ĐÂY LÀ NƠI DUY NHẤT trong mã nguồn được import plugin này.
 * Plugin Capacitor là một Proxy: trả thẳng nó qua async/Promise sẽ làm Promise gọi `.then` của nó
 * ("Preferences.then() is not implemented") và treo mãi, nên chỉ trả một đối tượng thường bọc ba hàm cần dùng.
 */
async function loadPreferencesPlugin(): Promise<PreferencesLike> {
  const { Preferences } = await import('@capacitor/preferences');
  return {
    get: (options) => Preferences.get(options),
    set: (options) => Preferences.set(options),
    remove: (options) => Preferences.remove(options),
  };
}

/** Bản Preferences (lưu native trong APK). `load` tiêm được để test chạy trong Node. */
export function createPreferencesPort(load: () => Promise<PreferencesLike> = loadPreferencesPlugin): KeyValuePort {
  let cached: Promise<PreferencesLike> | null = null;
  const plugin = (): Promise<PreferencesLike> => {
    cached ??= load().catch((e: unknown) => {
      cached = null; // lần sau cho phép nạp lại
      throw e;
    });
    return cached;
  };
  return {
    get: (key) =>
      guard('đọc', async () => {
        const { value } = await (await plugin()).get({ key });
        return typeof value === 'string' ? value : null;
      }),
    set: (key, value) => guard('lưu', async () => (await plugin()).set({ key, value })),
    remove: (key) => guard('xóa', async () => (await plugin()).remove({ key })),
  };
}

export interface DefaultPortsOptions {
  /** true khi chạy trong APK (getPlatform() === 'android-native'): ưu tiên Preferences. */
  native: boolean;
  /** Ghi đè localStorage (dùng khi test); null nghĩa là không có. Bỏ trống thì dùng localStorage thật nếu có. */
  storage?: StorageLike | null;
  /** Ghi đè cách nạp plugin Preferences (dùng khi test). */
  loadPreferences?: () => Promise<PreferencesLike>;
}

/** Các cổng bền theo thứ tự ưu tiên: Preferences (chỉ khi native) rồi localStorage. Bộ nhớ trong do kho cài đặt tự thêm cuối. */
export function createDefaultPorts(o: DefaultPortsOptions): KeyValuePort[] {
  const ports: KeyValuePort[] = [];
  if (o.native) ports.push(createPreferencesPort(o.loadPreferences));
  const storage = o.storage === undefined ? getLocalStorage() : o.storage;
  if (storage) ports.push(createLocalStoragePort(storage));
  return ports;
}