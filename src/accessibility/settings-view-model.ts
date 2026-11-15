/**
 * Mô tả các mục màn hình Cài đặt (F6) cho P11 dựng: nhãn tiếng Việt, kiểu (công tắc / nhóm radio / hành động),
 * giá trị hiện tại và hàm đổi. KHÔNG có mục chỉnh ngưỡng confidence: ngưỡng nhận dạng là việc của nhóm phát triển,
 * người dùng khiếm thị không thể tự kiểm chứng nên không được phép làm app "dễ tính" hơn (nguyên tắc Fail Safe).
 *
 * - value và valueText là getter: luôn phản ánh cài đặt MỚI NHẤT, P11 chỉ cần dựng lại khi settings-manager.subscribe báo.
 * - valueText luôn có chữ ("Bật", "Tắt", "Chậm"...) để trạng thái không phụ thuộc màu hay vị trí gạt.
 * - Mọi thay đổi đi qua hàm set của bên gọi (settings-manager.set) nên được áp dụng, lưu và xác nhận bằng giọng nói.
 * - Radio dùng giá trị chuỗi ('0.8', '1', '1.2' cho tốc độ) để khớp thẳng với <input type="radio">; chuỗi lạ bị bỏ qua.
 * - "Nghe lại hướng dẫn" là hành động chứ không phải cài đặt: truyền o.onReplayGuide để nối, không có thì run() không làm gì.
 */
import type { Settings } from '../contracts';
import { safeCall } from './a11y-shared';
import { SPEECH_RATES } from './settings-manager';

/** Chữ lớn bật = hệ số 1.5 (nằm trong khoảng 1..2 mà settings-manager cho phép); tắt = 1. */
export const LARGE_FONT_SCALE = 1.5;

export type SettingsItemId =
  | 'voice' | 'speechRate' | 'verbosity' | 'speechOutput' | 'vibration'
  | 'largeText' | 'highContrast' | 'autoStartCamera' | 'replayGuide';

interface ItemBase { readonly id: SettingsItemId; readonly label: string }

/** Công tắc bật/tắt. */
export interface SwitchItem extends ItemBase {
  readonly kind: 'switch';
  readonly value: boolean;
  readonly valueText: string;
  set(on: boolean): Promise<Settings>;
  toggle(): Promise<Settings>;
}

export interface RadioOption { readonly value: string; readonly label: string }

/** Nhóm lựa chọn một trong nhiều. */
export interface RadioItem extends ItemBase {
  readonly kind: 'radio';
  readonly value: string;
  readonly valueText: string;
  readonly options: readonly RadioOption[];
  set(value: string): Promise<Settings>;
}

/** Nút hành động (không lưu gì vào cài đặt). */
export interface ActionItem extends ItemBase {
  readonly kind: 'action';
  run(): void;
}

export type SettingsItem = SwitchItem | RadioItem | ActionItem;

type Setter = (p: Partial<Settings>) => Promise<Settings>;

function toSwitch(id: SettingsItemId, label: string, read: () => boolean, patch: (on: boolean) => Partial<Settings>, apply: Setter): SwitchItem {
  const change = (on: boolean): Promise<Settings> => apply(patch(on));
  return {
    id, label, kind: 'switch',
    get value() { return read(); },
    get valueText() { return read() ? 'Bật' : 'Tắt'; },
    set: change,
    toggle: () => change(!read()),
  };
}

function toRadio(
  id: SettingsItemId, label: string, options: readonly RadioOption[], read: () => string,
  patch: (value: string) => Partial<Settings> | null, apply: Setter, current: () => Settings,
): RadioItem {
  return {
    id, label, kind: 'radio', options,
    get value() { return read(); },
    get valueText() { return options.find((option) => option.value === read())?.label ?? ''; },
    set(value: string) {
      const p = patch(value);
      return p === null ? Promise.resolve(current()) : apply(p);
    },
  };
}

export function buildSettingsViewModel(
  get: () => Settings,
  set: (p: Partial<Settings>) => Promise<Settings>,
  o?: { onReplayGuide?: () => void },
): SettingsItem[] {
  return [
    toSwitch('voice', 'Giọng nói', () => get().voiceEnabled, (on) => ({ voiceEnabled: on }), set),
    toRadio('speechRate', 'Tốc độ đọc', [
      { value: '0.8', label: 'Chậm' }, { value: '1', label: 'Bình thường' }, { value: '1.2', label: 'Nhanh' },
    ], () => String(get().speechRate), (value) => {
      const rate = Number(value);
      return (SPEECH_RATES as readonly number[]).includes(rate) ? { speechRate: rate } : null;
    }, set, get),
    toRadio('verbosity', 'Chế độ đọc', [
      { value: 'BRIEF', label: 'Ngắn gọn' }, { value: 'DETAILED', label: 'Chi tiết' },
    ], () => get().verbosity, (value) => (value === 'BRIEF' || value === 'DETAILED' ? { verbosity: value } : null), set, get),
    toRadio('speechOutput', 'Đọc bằng', [
      { value: 'APP_TTS', label: 'Giọng của ứng dụng' }, { value: 'SCREEN_READER', label: 'Trình đọc màn hình' },
    ], () => get().speechOutput, (value) => (value === 'APP_TTS' || value === 'SCREEN_READER' ? { speechOutput: value } : null), set, get),
    toSwitch('vibration', 'Rung', () => get().vibrationEnabled, (on) => ({ vibrationEnabled: on }), set),
    toSwitch('largeText', 'Chữ lớn', () => get().fontScale > 1, (on) => ({ fontScale: on ? LARGE_FONT_SCALE : 1 }), set),
    toSwitch('highContrast', 'Tương phản cao', () => get().highContrast, (on) => ({ highContrast: on }), set),
    toSwitch('autoStartCamera', 'Tự bật camera', () => get().autoStartCamera, (on) => ({ autoStartCamera: on }), set),
    { id: 'replayGuide', label: 'Nghe lại hướng dẫn', kind: 'action', run: () => safeCall('onReplayGuide', () => o?.onReplayGuide?.()) },
  ];
}