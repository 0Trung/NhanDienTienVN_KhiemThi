import { describe, expect, it, vi } from 'vitest';
import { createSettingsManager } from '../../src/accessibility/settings-manager';
import { buildSettingsViewModel } from '../../src/accessibility/settings-view-model';
import type { ActionItem, RadioItem, SettingsItem, SwitchItem } from '../../src/accessibility/settings-view-model';
import { DEFAULT_SETTINGS } from '../../src/config/app-config';
import type { SettingAck, Settings } from '../../src/contracts';
import { setLogSink } from '../../src/utils/logger';
import { MemorySettingsStore } from '../fakes';

function setup(initial: Partial<Settings> = {}, onReplayGuide?: () => void) {
  let state: Settings = { ...DEFAULT_SETTINGS, ...initial };
  const set = vi.fn(async (p: Partial<Settings>) => {
    state = { ...state, ...p };
    return { ...state };
  });
  const items = buildSettingsViewModel(() => ({ ...state }), set, { onReplayGuide });
  const item = <T extends SettingsItem>(id: SettingsItem['id']): T => {
    const found = items.find((i) => i.id === id);
    if (found === undefined) throw new Error(`Không có mục ${id}`);
    return found as T;
  };
  return { items, set, item };
}

describe('settings-view-model', () => {
  it('đủ các mục, đúng thứ tự, nhãn tiếng Việt, đúng kiểu', () => {
    expect(setup().items.map((i) => [i.id, i.label, i.kind])).toEqual([
      ['voice', 'Giọng nói', 'switch'], ['speechRate', 'Tốc độ đọc', 'radio'], ['verbosity', 'Chế độ đọc', 'radio'],
      ['speechOutput', 'Đọc bằng', 'radio'], ['vibration', 'Rung', 'switch'], ['largeText', 'Chữ lớn', 'switch'],
      ['highContrast', 'Tương phản cao', 'switch'], ['autoStartCamera', 'Tự bật camera', 'switch'], ['replayGuide', 'Nghe lại hướng dẫn', 'action'],
    ]);
  });

  it('KHÔNG có mục chỉnh ngưỡng confidence (id, nhãn, lựa chọn)', () => {
    const texts = setup().items.flatMap((i) => [i.id, i.label, ...(i.kind === 'radio' ? i.options.flatMap((o) => [o.value, o.label]) : [])]);
    expect(texts.filter((t) => /conf|ngưỡng|threshold|tin cậy|độ chắc/i.test(t))).toEqual([]);
  });

  it.each([
    ['voice', {}, { voiceEnabled: false }], ['vibration', {}, { vibrationEnabled: false }], ['highContrast', {}, { highContrast: true }],
    ['autoStartCamera', {}, { autoStartCamera: false }], ['largeText', {}, { fontScale: 1.5 }], ['largeText', { fontScale: 2 }, { fontScale: 1 }],
  ] as const)('công tắc %s: toggle gửi đúng bản vá', async (id, initial, patch) => {
    const { item, set } = setup(initial);
    await item<SwitchItem>(id).toggle();
    expect(set.mock.calls).toEqual([[patch]]);
  });

  it('công tắc: set(giá trị) gửi tường minh; value và valueText theo cài đặt mới nhất, luôn có chữ Bật/Tắt', async () => {
    const { item, set } = setup();
    const vibration = item<SwitchItem>('vibration');
    expect([vibration.value, vibration.valueText]).toEqual([true, 'Bật']);
    await vibration.set(false);
    expect([vibration.value, vibration.valueText, set.mock.calls]).toEqual([false, 'Tắt', [[{ vibrationEnabled: false }]]]);
  });

  it.each([[1, false], [1.2, true], [2, true]])('chữ lớn: fontScale %s → bật=%s', (fontScale, on) => {
    expect(setup({ fontScale }).item<SwitchItem>('largeText').value).toBe(on);
  });

  it.each([
    ['speechRate', '0.8', { speechRate: 0.8 }], ['speechRate', '1.2', { speechRate: 1.2 }],
    ['verbosity', 'BRIEF', { verbosity: 'BRIEF' }], ['speechOutput', 'SCREEN_READER', { speechOutput: 'SCREEN_READER' }],
  ] as const)('radio %s: chọn "%s" gửi đúng bản vá', async (id, value, patch) => {
    const { item, set } = setup();
    await item<RadioItem>(id).set(value);
    expect(set.mock.calls).toEqual([[patch]]);
  });

  it.each([['speechRate', '0.9'], ['speechRate', 'abc'], ['verbosity', 'LONG'], ['speechOutput', '']] as const)(
    'radio %s: giá trị lạ "%s" bị bỏ qua, không gọi set',
    async (id, value) => {
      const { item, set } = setup();
      expect(await item<RadioItem>(id).set(value)).toEqual(DEFAULT_SETTINGS);
      expect(set).not.toHaveBeenCalled();
    },
  );

  it('radio có lựa chọn tiếng Việt; value và valueText theo cài đặt mới nhất', async () => {
    const { item } = setup({ speechRate: 1.2 });
    const rate = item<RadioItem>('speechRate');
    expect(rate.options).toEqual([{ value: '0.8', label: 'Chậm' }, { value: '1', label: 'Bình thường' }, { value: '1.2', label: 'Nhanh' }]);
    expect([rate.value, rate.valueText]).toEqual(['1.2', 'Nhanh']);
    await rate.set('0.8');
    expect([rate.value, rate.valueText]).toEqual(['0.8', 'Chậm']);
    expect(item<RadioItem>('verbosity').options.map((o) => o.label)).toEqual(['Ngắn gọn', 'Chi tiết']);
    expect(item<RadioItem>('speechOutput').options.map((o) => o.label)).toEqual(['Giọng của ứng dụng', 'Trình đọc màn hình']);
  });

  it('mục hành động: run gọi onReplayGuide; không nối hoặc nối hàm ném lỗi thì không làm hỏng', () => {
    setLogSink(() => undefined);
    const handler = vi.fn();
    setup({}, handler).item<ActionItem>('replayGuide').run();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(() => setup().item<ActionItem>('replayGuide').run()).not.toThrow();
    expect(() => setup({}, () => { throw new Error('boom'); }).item<ActionItem>('replayGuide').run()).not.toThrow();
    setLogSink(null);
  });

  it('nối với settings-manager thật: đổi qua view-model được lưu và có ack bằng giọng', async () => {
    const store = new MemorySettingsStore();
    const acks: SettingAck[] = [];
    const manager = createSettingsManager(store, (a) => acks.push(a), { matchMedia: () => ({ matches: false }) });
    await manager.load();
    const items = buildSettingsViewModel(manager.get, manager.set);
    const find = <T extends SettingsItem>(id: SettingsItem['id']): T => items.find((i) => i.id === id) as T;
    await find<SwitchItem>('vibration').toggle();
    await find<RadioItem>('speechRate').set('1.2');
    expect(acks).toEqual(['VIBRATION_OFF', 'RATE_FAST']);
    expect(store.snapshot).toMatchObject({ vibrationEnabled: false, speechRate: 1.2 });
  });
});