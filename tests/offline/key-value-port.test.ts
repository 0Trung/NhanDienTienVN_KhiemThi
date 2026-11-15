import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/contracts';
import {
  createDefaultPorts,
  createLocalStoragePort,
  createMemoryPort,
  createPreferencesPort,
} from '../../src/offline/key-value-port';
import type { PreferencesLike, StorageLike } from '../../src/offline/key-value-port';

/** Storage giả; broken=true thì mọi thao tác ném lỗi hết dung lượng. */
function fakeStorage(broken = false): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const check = (): void => {
    if (broken) throw new DOMException('đầy bộ nhớ', 'QuotaExceededError');
  };
  return {
    map,
    getItem: (key) => (check(), map.get(key) ?? null),
    setItem: (key, value) => (check(), void map.set(key, value)),
    removeItem: (key) => (check(), void map.delete(key)),
  };
}

/** Plugin giả ghi lại đúng hình dạng lời gọi: mỗi thao tác nhận MỘT đối tượng tùy chọn. */
function fakePreferences(broken = false) {
  const data = new Map<string, string>();
  const log: Array<[string, unknown]> = [];
  const call = (op: string, options: unknown): void => {
    log.push([op, options]);
    if (broken) throw new Error('plugin lỗi');
  };
  const plugin: PreferencesLike = {
    get: async (o) => (call('get', o), { value: data.get(o.key) ?? null }),
    set: async (o) => (call('set', o), void data.set(o.key, o.value)),
    remove: async (o) => (call('remove', o), void data.delete(o.key)),
  };
  return { plugin, data, log };
}

describe('createMemoryPort', () => {
  it('lưu, đọc, xóa; hai bản độc lập nhau', async () => {
    const port = createMemoryPort();
    expect(await port.get('k')).toBeNull();
    await port.set('k', 'v');
    expect(await port.get('k')).toBe('v');
    expect(await createMemoryPort().get('k')).toBeNull();
    await port.remove('k');
    expect(await port.get('k')).toBeNull();
  });
});

describe('createLocalStoragePort', () => {
  it('lưu, đọc và xóa qua Storage', async () => {
    const storage = fakeStorage();
    const port = createLocalStoragePort(storage);
    await port.set('k', 'v');
    expect(storage.map.get('k')).toBe('v');
    expect(await port.get('k')).toBe('v');
    await port.remove('k');
    expect(await port.get('k')).toBeNull();
  });

  it.each(['get', 'set', 'remove'] as const)('Storage ném lỗi ở %s thì thành AppError STORAGE_FAILED', async (op) => {
    const port = createLocalStoragePort(fakeStorage(true));
    const run = { get: () => port.get('k'), set: () => port.set('k', 'v'), remove: () => port.remove('k') }[op];
    await expect(run()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('không có Storage (null) thì mọi thao tác lỗi STORAGE_FAILED', async () => {
    await expect(createLocalStoragePort(null).get('k')).rejects.toBeInstanceOf(AppError);
  });
});

describe('createPreferencesPort', () => {
  it('gọi plugin với đối tượng tùy chọn đúng hình dạng', async () => {
    const { plugin, log } = fakePreferences();
    const port = createPreferencesPort(async () => plugin);
    expect(await port.get('k')).toBeNull();
    await port.set('k', 'v');
    expect(await port.get('k')).toBe('v');
    await port.remove('k');
    expect(log).toEqual([
      ['get', { key: 'k' }],
      ['set', { key: 'k', value: 'v' }],
      ['get', { key: 'k' }],
      ['remove', { key: 'k' }],
    ]);
  });

  it('nạp plugin một lần và chỉ khi cần', async () => {
    let loads = 0;
    const { plugin } = fakePreferences();
    const port = createPreferencesPort(async () => (loads += 1, plugin));
    expect(loads).toBe(0);
    await port.set('a', '1');
    await port.get('a');
    expect(loads).toBe(1);
  });

  it('plugin ném lỗi thì thành AppError STORAGE_FAILED', async () => {
    const port = createPreferencesPort(async () => fakePreferences(true).plugin);
    await expect(port.set('k', 'v')).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('nạp plugin thất bại thì báo STORAGE_FAILED và lần sau thử nạp lại', async () => {
    let attempts = 0;
    const { plugin } = fakePreferences();
    const port = createPreferencesPort(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('không nạp được');
      return plugin;
    });
    await expect(port.get('k')).rejects.toBeInstanceOf(AppError);
    await expect(port.get('k')).resolves.toBeNull();
  });

  it('plugin thật: nạp được trong Node, không treo; không có WebView thì lỗi nổi lên dưới dạng AppError', async () => {
    await expect(createPreferencesPort().get('k')).rejects.toBeInstanceOf(AppError);
  });
});

describe('createDefaultPorts', () => {
  it('trong APK: Preferences đứng trước, localStorage sau', async () => {
    const { plugin, data } = fakePreferences();
    const storage = fakeStorage();
    const ports = createDefaultPorts({ native: true, storage, loadPreferences: async () => plugin });
    expect(ports).toHaveLength(2);
    await ports[0]?.set('k', 'v');
    expect([data.get('k'), storage.map.size]).toEqual(['v', 0]);
    await ports[1]?.set('k', 'w');
    expect(storage.map.get('k')).toBe('w');
  });

  it('ngoài APK: chỉ localStorage; không có localStorage thì rỗng', async () => {
    const storage = fakeStorage();
    const ports = createDefaultPorts({ native: false, storage });
    expect(ports).toHaveLength(1);
    await ports[0]?.set('k', 'v');
    expect(storage.map.get('k')).toBe('v');
    expect(createDefaultPorts({ native: false, storage: null })).toEqual([]);
  });
});