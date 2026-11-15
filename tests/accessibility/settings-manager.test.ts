// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsManager } from '../../src/accessibility/settings-manager';
import { DEFAULT_SETTINGS } from '../../src/config/app-config';
import { AppError } from '../../src/contracts';
import type { ISettingsStore, SettingAck, Settings } from '../../src/contracts';
import { setLogSink } from '../../src/utils/logger';
import { MemorySettingsStore } from '../fakes';

const MORE_CONTRAST = '(prefers-contrast: more)';
const NO_MEDIA = { matchMedia: () => ({ matches: false }) };

function setup(initial: Partial<Settings> = {}, matching: string[] = []) {
  const store = new MemorySettingsStore(initial);
  const acks: SettingAck[] = [];
  const target = document.createElement('div');
  const manager = createSettingsManager(store, (a) => acks.push(a), { target, matchMedia: (query) => ({ matches: matching.includes(query) }) });
  return { store, acks, target, manager, css: (name: string): string => target.style.getPropertyValue(name) };
}

describe('settings-manager', () => {
  beforeEach(() => setLogSink(() => undefined));
  afterEach(() => setLogSink(null));

  it('load nạp từ store và áp biến CSS + thuộc tính lên phần tử gốc', async () => {
    const { manager, target, css } = setup({ fontScale: 1.5, highContrast: true, speechOutput: 'SCREEN_READER' });
    expect((await manager.load()).fontScale).toBe(1.5);
    expect([css('--font-scale'), css('--a11y-bg'), target.getAttribute('data-contrast'), target.getAttribute('data-speech-output')])
      .toEqual(['1.5', '#000000', 'high', 'SCREEN_READER']);
  });

  it('set áp CSS ngay (không đợi lưu xong); tắt tương phản cao thì gỡ các biến tương phản', async () => {
    const { manager, target, css } = setup({ highContrast: true });
    await manager.load();
    const pending = manager.set({ fontScale: 2, highContrast: false });
    expect([css('--font-scale'), css('--a11y-bg'), target.getAttribute('data-contrast')]).toEqual(['2', '', 'normal']);
    await pending;
  });

  it.each([[0.2, 1], [1.4, 1.4], [5, 2], [Infinity, 2]])('kẹp fontScale %s → %s', async (input, expected) => {
    const { manager, css } = setup();
    await manager.load();
    expect((await manager.set({ fontScale: input })).fontScale).toBe(expected);
    expect(css('--font-scale')).toBe(String(expected));
  });

  it.each([[0.5, 0.8], [0.95, 1], [1.15, 1.2], [9, 1.2]])('speechRate %s chỉ nhận ba mức → %s', async (input, expected) => {
    const { manager } = setup();
    await manager.load();
    expect((await manager.set({ speechRate: input })).speechRate).toBe(expected);
  });

  it('trường sai kiểu giữ giá trị cũ; dữ liệu hỏng trong store được kẹp ngay khi nạp', async () => {
    const { manager } = setup();
    await manager.load();
    const bad = { fontScale: NaN, speechRate: NaN, verbosity: 'LONG' as never, speechOutput: 'X' as never, voiceEnabled: 'yes' as never };
    expect(await manager.set(bad)).toEqual(DEFAULT_SETTINGS);
    const loaded = await setup({ fontScale: 9, speechRate: 0.7, verbosity: 'X' as never }).manager.load();
    expect([loaded.fontScale, loaded.speechRate, loaded.verbosity]).toEqual([2, 0.8, 'DETAILED']);
  });

  // [tên, cài đặt ban đầu, bản vá, các ack mong đợi]
  const acksTable: Array<[string, Partial<Settings>, Partial<Settings>, SettingAck[]]> = [
    ['bật giọng nói', { voiceEnabled: false }, { voiceEnabled: true }, ['VOICE_ON']],
    ['tắt giọng nói: im lặng theo bản chất', {}, { voiceEnabled: false }, []],
    ['tắt rung', {}, { vibrationEnabled: false }, ['VIBRATION_OFF']],
    ['bật rung', { vibrationEnabled: false }, { vibrationEnabled: true }, ['VIBRATION_ON']],
    ['bật đèn', {}, { torchEnabled: true }, ['TORCH_ON']],
    ['tắt đèn', { torchEnabled: true }, { torchEnabled: false }, ['TORCH_OFF']],
    ['đọc chậm', {}, { speechRate: 0.8 }, ['RATE_SLOW']],
    ['đọc thường', { speechRate: 1.2 }, { speechRate: 1.0 }, ['RATE_NORMAL']],
    ['đọc nhanh', {}, { speechRate: 1.2 }, ['RATE_FAST']],
    ['đọc ngắn', {}, { verbosity: 'BRIEF' }, ['VERBOSITY_BRIEF']],
    ['đọc chi tiết', { verbosity: 'BRIEF' }, { verbosity: 'DETAILED' }, ['VERBOSITY_DETAILED']],
    ['không đổi giá trị thì không ack', {}, { speechRate: 1.0, vibrationEnabled: true }, []],
    ['chữ lớn, tương phản cao: Khối B chưa có mã ack', {}, { fontScale: 1.5, highContrast: true }, []],
    ['đổi nhiều trường: ack theo thứ tự cố định', {}, { torchEnabled: true, vibrationEnabled: false, speechRate: 0.8 }, ['RATE_SLOW', 'VIBRATION_OFF', 'TORCH_ON']],
  ];
  it.each(acksTable)('ack: %s', async (_name, initial, patch, expected) => {
    const { manager, acks } = setup(initial);
    await manager.load();
    await manager.set(patch);
    expect(acks).toEqual(expected);
  });

  it('ack được phát SAU khi trạng thái đã đổi; onAck ném lỗi không làm hỏng set', async () => {
    const seen: boolean[] = [];
    const store = new MemorySettingsStore();
    const manager = createSettingsManager(store, () => { seen.push(manager.get().vibrationEnabled); throw new Error('boom'); }, NO_MEDIA);
    await manager.load();
    await manager.set({ vibrationEnabled: false });
    expect([seen, store.snapshot.vibrationEnabled]).toEqual([[false], false]);
  });

  it('lưu xuống store chỉ phần đã đổi và không lưu khi không đổi', async () => {
    const { manager, store } = setup();
    await manager.load();
    await manager.set({ vibrationEnabled: false, fontScale: 1.5 });
    await manager.set({ vibrationEnabled: false });
    expect(store.saveCalls).toBe(1);
    expect(store.snapshot).toMatchObject({ vibrationEnabled: false, fontScale: 1.5 });
  });

  it('các lần lưu đi theo đúng thứ tự gọi dù lần đầu chậm hơn', async () => {
    const order: number[] = [];
    let call = 0;
    const slowStore: ISettingsStore = {
      load: async () => ({ ...DEFAULT_SETTINGS }),
      save: async (patch) => {
        call += 1;
        await new Promise((resolve) => setTimeout(resolve, call === 1 ? 20 : 0));
        if (patch.speechRate !== undefined) order.push(patch.speechRate);
        return { ...DEFAULT_SETTINGS };
      },
      reset: async () => ({ ...DEFAULT_SETTINGS }),
    };
    const manager = createSettingsManager(slowStore, () => undefined, NO_MEDIA);
    await manager.load();
    await Promise.all([manager.set({ speechRate: 0.8 }), manager.set({ speechRate: 1.2 })]);
    expect(order).toEqual([0.8, 1.2]);
  });

  it('subscribe báo mỗi lần nạp/đổi, hủy đăng ký thì ngừng, lỗi của một bên không ảnh hưởng bên khác; get trả bản sao', async () => {
    const { manager } = setup();
    const seen: number[] = [];
    const bad = vi.fn(() => { throw new Error('boom'); });
    manager.subscribe(bad);
    const off = manager.subscribe((s) => seen.push(s.fontScale));
    await manager.load();
    await manager.set({ fontScale: 1.5 });
    off();
    await manager.set({ fontScale: 2 });
    manager.get().fontScale = 1;
    expect([seen, bad.mock.calls.length, manager.get().fontScale]).toEqual([[1, 1.5], 3, 2]);
  });

  it('prefers-contrast: more mà người dùng chưa chọn → tương phản cao, KHÔNG lưu xuống store', async () => {
    const { manager, store, target } = setup({}, [MORE_CONTRAST]);
    expect((await manager.load()).highContrast).toBe(true);
    expect([target.getAttribute('data-contrast'), store.saveCalls]).toEqual(['high', 0]);
  });

  it('người dùng tự tắt tương phản thì thắng prefers-contrast, kể cả sau đổi việc khác hay nạp lại', async () => {
    const { manager, target } = setup({}, [MORE_CONTRAST]);
    await manager.load();
    await manager.set({ highContrast: false });
    await manager.set({ fontScale: 1.5 });
    expect([manager.get().highContrast, target.getAttribute('data-contrast')]).toEqual([false, 'normal']);
    expect((await manager.load()).highContrast).toBe(false);
  });

  it.each([
    [['(prefers-reduced-motion: reduce)'], 'reduce', '0'],
    [[], 'full', '1'],
  ])('prefers-reduced-motion %j → data-motion=%s, --motion-scale=%s', async (matching, attr, scale) => {
    const { manager, target, css } = setup({}, matching);
    await manager.load();
    expect([target.getAttribute('data-motion'), css('--motion-scale')]).toEqual([attr, scale]);
  });

  it('lỗi store: nạp lỗi giữ giá trị hiện có và vẫn áp CSS; lưu lỗi vẫn có hiệu lực trong phiên và vẫn ack', async () => {
    const { manager, store, acks, css } = setup();
    store.failWith = new AppError('STORAGE_FAILED', 'hỏng');
    expect(await manager.load()).toEqual(DEFAULT_SETTINGS);
    expect(css('--font-scale')).toBe('1');
    const result = await manager.set({ fontScale: 1.5, vibrationEnabled: false });
    expect([result.fontScale, css('--font-scale'), acks]).toEqual([1.5, '1.5', ['VIBRATION_OFF']]);
  });
});