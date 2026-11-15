import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/config/app-config';
import { AppError } from '../../src/contracts';
import type { Settings } from '../../src/contracts';
import type { KeyValuePort } from '../../src/offline/key-value-port';
import {
  CURRENT_SCHEMA_VERSION,
  SETTINGS_STORAGE_KEY,
  createSettingsStore,
  createSettingsStoreWith,
  migrate,
} from '../../src/offline/settings-store';
import type { MigrationSteps } from '../../src/offline/settings-store';
import { setLogSink } from '../../src/utils/logger';
import { makeFakeBitmap } from '../fakes/fake-camera';

type Op = 'get' | 'set' | 'remove';

/** Cổng giả: nhớ dữ liệu, đếm lời gọi, làm hỏng được từng thao tác, trễ một nhịp để lộ lỗi chạy chồng. */
class FakePort implements KeyValuePort {
  readonly data = new Map<string, string>();
  readonly calls: Record<Op, number> = { get: 0, set: 0, remove: 0 };
  fail: Partial<Record<Op, boolean>> = {};

  private async tick(op: Op): Promise<void> {
    this.calls[op] += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (this.fail[op]) throw new AppError('STORAGE_FAILED', `giả lập lỗi ${op}`);
  }
  async get(key: string): Promise<string | null> {
    await this.tick('get');
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    await this.tick('set');
    this.data.set(key, value);
  }
  async remove(key: string): Promise<void> {
    await this.tick('remove');
    this.data.delete(key);
  }
}

const seed = (port: FakePort, value: unknown): void => {
  port.data.set(SETTINGS_STORAGE_KEY, typeof value === 'string' ? value : JSON.stringify(value));
};
const stored = (port: FakePort): Record<string, unknown> => JSON.parse(port.data.get(SETTINGS_STORAGE_KEY) ?? 'null');
const KEYS = Object.keys(DEFAULT_SETTINGS).sort();
const asPatch = (value: unknown): Partial<Settings> => value as Partial<Settings>;

describe('createSettingsStoreWith', () => {
  let port: FakePort;
  beforeEach(() => {
    setLogSink(() => undefined);
    port = new FakePort();
  });
  afterEach(() => setLogSink(null));

  it('lần đầu chưa lưu gì thì trả mặc định', async () => {
    expect(await createSettingsStoreWith([port]).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('save một phần: hợp nhất với mặc định và ghi MỘT khóa JSON duy nhất', async () => {
    const store = createSettingsStoreWith([port]);
    const saved = await store.save({ fontScale: 1.5, highContrast: true });
    expect(saved).toEqual({ ...DEFAULT_SETTINGS, fontScale: 1.5, highContrast: true });
    expect([...port.data.keys()]).toEqual([SETTINGS_STORAGE_KEY]);
    expect(await store.load()).toEqual(saved);
  });

  it('save lần sau giữ giá trị của lần trước; undefined không xóa giá trị đang có', async () => {
    const store = createSettingsStoreWith([port]);
    await store.save({ fontScale: 1.5 });
    expect(await store.save({ vibrationEnabled: false, highContrast: undefined })).toMatchObject({
      fontScale: 1.5,
      vibrationEnabled: false,
    });
  });

  it('khóa lạ trong bản vá bị loại, không được ghi', async () => {
    await createSettingsStoreWith([port]).save(asPatch({ fontScale: 1.5, evil: 'x', schemaVersion: 9 }));
    expect(Object.keys(stored(port)).sort()).toEqual(KEYS);
    expect(stored(port).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('khóa lạ trong dữ liệu đã lưu bị loại khi load', async () => {
    seed(port, { fontScale: 1.5, evil: 'x', admin: true });
    const loaded = await createSettingsStoreWith([port]).load();
    expect(Object.keys(loaded).sort()).toEqual(KEYS);
    expect(loaded.fontScale).toBe(1.5);
  });

  it.each([
    { key: 'voiceEnabled', value: 0 },
    { key: 'torchEnabled', value: 'yes' },
    { key: 'speechRate', value: '1.2' },
    { key: 'fontScale', value: null },
    { key: 'verbosity', value: 'LOUD' },
    { key: 'speechOutput', value: 3 },
    { key: 'voiceLanguage', value: 'en-US' },
    { key: 'modelVersion', value: 42 },
    { key: 'modelVersion', value: '   ' },
    { key: 'modelVersion', value: 'x'.repeat(33) },
  ])('sai kiểu $key=$value thì về mặc định', async ({ key, value }) => {
    seed(port, { [key]: value });
    const loaded = await createSettingsStoreWith([port]).load();
    expect(loaded[key as keyof Settings]).toBe(DEFAULT_SETTINGS[key as keyof Settings]);
  });

  it.each([
    { key: 'fontScale', value: 0.5, expected: 1 },
    { key: 'fontScale', value: 1.5, expected: 1.5 },
    { key: 'fontScale', value: 3, expected: 2 },
    { key: 'speechRate', value: 0.8, expected: 0.8 },
    { key: 'speechRate', value: 1.2, expected: 1.2 },
    { key: 'speechRate', value: 0.1, expected: 0.8 },
    { key: 'speechRate', value: 0.95, expected: 1 },
    { key: 'speechRate', value: 2, expected: 1.2 },
  ])('kẹp $key=$value thành $expected', async ({ key, value, expected }) => {
    const saved = await createSettingsStoreWith([port]).save(asPatch({ [key]: value }));
    expect(saved[key as keyof Settings]).toBe(expected);
  });

  it('JSON hỏng thì dùng mặc định, save sau đó ghi đè lại bản tốt', async () => {
    seed(port, '{không phải json');
    const store = createSettingsStoreWith([port]);
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
    await store.save({ fontScale: 1.5 });
    expect(stored(port).fontScale).toBe(1.5);
  });

  it('dữ liệu cũ chưa có schemaVersion vẫn đọc được và được ghi lại với schemaVersion hiện tại', async () => {
    seed(port, { voiceEnabled: false });
    const store = createSettingsStoreWith([port]);
    expect(await store.load()).toMatchObject({ voiceEnabled: false, schemaVersion: CURRENT_SCHEMA_VERSION });
    await store.save({});
    expect(stored(port).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('ba save chạy song song đều được áp dụng (không ghi đè nhau)', async () => {
    const store = createSettingsStoreWith([port]);
    await Promise.all([store.save({ fontScale: 1.5 }), store.save({ highContrast: true }), store.save({ speechRate: 1.2 })]);
    expect(await store.load()).toMatchObject({ fontScale: 1.5, highContrast: true, speechRate: 1.2 });
  });

  it('reset xóa khóa ở mọi cổng và trả mặc định', async () => {
    const second = new FakePort();
    const store = createSettingsStoreWith([port, second]);
    seed(port, { fontScale: 1.5 });
    seed(second, { fontScale: 2 });
    expect(await store.reset()).toEqual(DEFAULT_SETTINGS);
    expect(port.data.size + second.data.size).toBe(0);
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('createSettingsStoreWith: cổng ném lỗi thì rơi về dự phòng', () => {
  let bad: FakePort;
  beforeEach(() => {
    setLogSink(() => undefined);
    bad = new FakePort();
    bad.fail = { get: true, set: true, remove: true };
  });
  afterEach(() => setLogSink(null));

  it('cổng duy nhất hỏng hoàn toàn: load, save, reset vẫn chạy trong phiên (bộ nhớ trong)', async () => {
    const store = createSettingsStoreWith([bad]);
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
    expect((await store.save({ fontScale: 1.5 })).fontScale).toBe(1.5);
    expect((await store.load()).fontScale).toBe(1.5);
    expect(await store.reset()).toEqual(DEFAULT_SETTINGS);
    expect((await store.load()).fontScale).toBe(DEFAULT_SETTINGS.fontScale);
  });

  it('cổng đầu hỏng thì ghi sang cổng kế tiếp', async () => {
    const good = new FakePort();
    await createSettingsStoreWith([bad, good]).save({ fontScale: 1.5 });
    expect(stored(good).fontScale).toBe(1.5);
  });

  it('cổng đầu trống thì đọc từ cổng kế tiếp', async () => {
    const good = new FakePort();
    seed(good, { fontScale: 1.5 });
    expect((await createSettingsStoreWith([new FakePort(), good]).load()).fontScale).toBe(1.5);
  });

  it('hai cổng tốt: chỉ ghi vào cổng đầu', async () => {
    const [first, second] = [new FakePort(), new FakePort()];
    await createSettingsStoreWith([first, second]).save({ fontScale: 1.5 });
    expect([first.calls.set, second.calls.set]).toEqual([1, 0]);
  });
});

describe('quyền riêng tư: save luôn qua assertNoImageData', () => {
  it.each([
    { name: 'chuỗi data:image', patch: { modelVersion: 'data:image/png;base64,AAAA' } },
    { name: 'ImageBitmap ở khóa lạ', patch: { frame: makeFakeBitmap(2, 2) } },
    { name: 'mảng byte lớn', patch: { fontScale: new Uint8Array(5000) } },
  ])('từ chối $name và không ghi gì', async ({ patch }) => {
    const port = new FakePort();
    await expect(createSettingsStoreWith([port]).save(asPatch(patch))).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(port.calls.set).toBe(0);
  });
});

describe('migrate', () => {
  it('dữ liệu chưa có schemaVersion (bản 0) lên bản hiện tại, giữ nguyên giá trị', () => {
    expect(migrate({ voiceEnabled: false })).toEqual({ voiceEnabled: false, schemaVersion: CURRENT_SCHEMA_VERSION });
  });

  it.each([{ v: '1' }, { v: -1 }])('schemaVersion $v không hợp lệ coi như bản 0', ({ v }) => {
    const steps: MigrationSteps = { 0: (d) => ({ ...d, daQuaBuoc0: true }) };
    expect(migrate({ schemaVersion: v }, steps, 1)).toMatchObject({ daQuaBuoc0: true, schemaVersion: 1 });
  });

  it('chạy lần lượt các bước từ phiên bản nguồn đến đích', () => {
    const steps: MigrationSteps = { 0: (d) => ({ ...d, a: 1 }), 1: (d) => ({ ...d, b: Number(d.a) + 1 }) };
    expect(migrate({}, steps, 2)).toEqual({ a: 1, b: 2, schemaVersion: 2 });
  });

  it('bỏ qua các bước thấp hơn phiên bản đã lưu', () => {
    const steps: MigrationSteps = { 0: (d) => ({ ...d, a: 1 }), 1: (d) => ({ ...d, b: 2 }) };
    expect(migrate({ schemaVersion: 1 }, steps, 2)).toEqual({ b: 2, schemaVersion: 2 });
  });

  it('dữ liệu do bản mới hơn ghi: giữ giá trị, gắn lại phiên bản đích', () => {
    setLogSink(() => undefined);
    expect(migrate({ schemaVersion: 7, voiceEnabled: false })).toEqual({ schemaVersion: 1, voiceEnabled: false });
    setLogSink(null);
  });
});

describe('createSettingsStore', () => {
  it('ngoài APK vẫn chạy được (localStorage nếu có, không thì bộ nhớ trong)', async () => {
    const store = createSettingsStore();
    await store.reset();
    await store.save({ speechRate: 1.2 });
    expect((await store.load()).speechRate).toBe(1.2);
    await store.reset();
  });
});