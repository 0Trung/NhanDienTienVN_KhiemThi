/**
 * Quản lý cài đặt trong bộ nhớ (F5): bọc ISettingsStore thành trạng thái có get / set(patch) / subscribe.
 * Mỗi thay đổi được ÁP DỤNG NGAY, rồi lưu xuống store (bất đồng bộ, đúng thứ tự):
 * - --font-scale trên <html> (P11 dùng calc(1rem * var(--font-scale))); data-contrast="high|normal" cùng các biến
 *   --a11y-fg, --a11y-bg, --a11y-border-width khi tương phản cao; data-motion="reduce|full" và --motion-scale
 *   theo prefers-reduced-motion; data-speech-output="APP_TTS|SCREEN_READER" (accessibility-manager đọc thuộc tính này).
 * - Phát SettingAck qua onAck SAU khi trạng thái đã đổi (speech manager đọc get() mới) để giọng nói xác nhận.
 *   Chỉ phát khi giá trị thật sự đổi. Khối B chưa có mã ack cho: tắt giọng nói, chữ lớn, tương phản cao, cách đọc,
 *   tự bật camera; các mục đó không phát ack (xem "Đề xuất sửa hợp đồng").
 * Giá trị ngoài phạm vi bị kẹp: fontScale trong [1, 2]; speechRate chỉ ba mức 0.8 / 1.0 / 1.2 (lấy mức gần nhất,
 * cách đều thì lấy mức chậm hơn); trường sai kiểu thì giữ giá trị cũ.
 * prefers-contrast: highContrast = false được coi là "chưa chọn" lúc nạp: nếu hệ điều hành đòi tương phản cao thì
 * trạng thái trong bộ nhớ là true (KHÔNG lưu xuống store). Khi người dùng tự đặt highContrast thì lựa chọn đó thắng.
 * Lỗi store: nạp lỗi thì giữ giá trị hiện có; lưu lỗi thì giá trị vẫn có hiệu lực trong phiên và chỉ ghi log.
 */
import { DEFAULT_SETTINGS } from '../config/app-config';
import type { ISettingsStore, SettingAck, Settings } from '../contracts';
import { createLogger } from '../utils/logger';
import { clamp } from '../utils/math';
import { SPEECH_OUTPUT_ATTR, safeCall } from './a11y-shared';

const log = createLogger('settings');

export const FONT_SCALE_MIN = 1;
export const FONT_SCALE_MAX = 2;
export const SPEECH_RATES = [0.8, 1.0, 1.2] as const;

const QUERY_CONTRAST_MORE = '(prefers-contrast: more)';
const QUERY_REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const HIGH_CONTRAST_VARS: ReadonlyArray<readonly [string, string]> = [
  ['--a11y-fg', '#ffffff'], ['--a11y-bg', '#000000'], ['--a11y-border-width', '4px'],
];

/** Tham số phụ (tùy chọn) để tiêm DOM và truy vấn media khi test; P11 gọi hai tham số vẫn đúng. */
export interface SettingsManagerOptions {
  /** Phần tử nhận biến CSS và thuộc tính data-*; mặc định <html>. Không có DOM thì chỉ giữ trạng thái. */
  target?: HTMLElement;
  /** Truy vấn media (prefers-*); mặc định window.matchMedia. */
  matchMedia?: (query: string) => { matches: boolean };
}

export interface SettingsManager {
  load(): Promise<Settings>;
  get(): Settings;
  set(p: Partial<Settings>): Promise<Settings>;
  subscribe(h: (s: Settings) => void): () => void;
}

function snapRate(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  let best: number = SPEECH_RATES[0];
  for (const rate of SPEECH_RATES) if (Math.abs(rate - value) < Math.abs(best - value)) best = rate;
  return best;
}

const pickBool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/** Gộp input lên base, kẹp giá trị và bỏ qua trường sai kiểu. Không mang theo khóa lạ. */
function sanitize(input: Partial<Settings>, base: Settings): Settings {
  return {
    schemaVersion: 1,
    voiceEnabled: pickBool(input.voiceEnabled, base.voiceEnabled),
    voiceLanguage: 'vi-VN',
    speechRate: snapRate(input.speechRate, base.speechRate),
    verbosity: input.verbosity === 'BRIEF' || input.verbosity === 'DETAILED' ? input.verbosity : base.verbosity,
    speechOutput: input.speechOutput === 'APP_TTS' || input.speechOutput === 'SCREEN_READER' ? input.speechOutput : base.speechOutput,
    vibrationEnabled: pickBool(input.vibrationEnabled, base.vibrationEnabled),
    torchEnabled: pickBool(input.torchEnabled, base.torchEnabled),
    fontScale: typeof input.fontScale === 'number' && !Number.isNaN(input.fontScale)
      ? clamp(input.fontScale, FONT_SCALE_MIN, FONT_SCALE_MAX) : base.fontScale,
    highContrast: pickBool(input.highContrast, base.highContrast),
    autoStartCamera: pickBool(input.autoStartCamera, base.autoStartCamera),
    modelVersion: typeof input.modelVersion === 'string' && input.modelVersion !== '' ? input.modelVersion : base.modelVersion,
  };
}

function diff(prev: Settings, next: Settings): Partial<Settings> {
  const changed: Partial<Settings> = {};
  for (const key of Object.keys(next) as Array<keyof Settings>) {
    if (next[key] !== prev[key]) Object.assign(changed, { [key]: next[key] });
  }
  return changed;
}

/** Mã ack cho các trường vừa đổi (chỉ những trường Khối B có mã). Bật giọng nói có ack, tắt thì im lặng theo bản chất. */
function acksFor(changed: Partial<Settings>): SettingAck[] {
  const acks: SettingAck[] = [];
  if (changed.voiceEnabled === true) acks.push('VOICE_ON');
  if (changed.speechRate !== undefined) {
    acks.push(changed.speechRate <= SPEECH_RATES[0] ? 'RATE_SLOW' : changed.speechRate >= SPEECH_RATES[2] ? 'RATE_FAST' : 'RATE_NORMAL');
  }
  if (changed.verbosity !== undefined) acks.push(changed.verbosity === 'BRIEF' ? 'VERBOSITY_BRIEF' : 'VERBOSITY_DETAILED');
  if (changed.vibrationEnabled !== undefined) acks.push(changed.vibrationEnabled ? 'VIBRATION_ON' : 'VIBRATION_OFF');
  if (changed.torchEnabled !== undefined) acks.push(changed.torchEnabled ? 'TORCH_ON' : 'TORCH_OFF');
  return acks;
}

export function createSettingsManager(
  store: ISettingsStore,
  onAck: (a: SettingAck) => void,
  options?: SettingsManagerOptions,
): SettingsManager {
  let state: Settings = { ...DEFAULT_SETTINGS };
  let contrastChosen = false;
  let saveChain: Promise<void> = Promise.resolve();
  const listeners = new Set<(s: Settings) => void>();
  const target = options?.target ?? (typeof document === 'undefined' ? null : document.documentElement);
  const media = options?.matchMedia
    ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? (q: string) => window.matchMedia(q) : null);
  const prefers = (query: string): boolean => {
    try {
      return media?.(query).matches === true;
    } catch {
      return false;
    }
  };

  function apply(): void {
    if (target === null) return;
    const reduceMotion = prefers(QUERY_REDUCED_MOTION);
    target.style.setProperty('--font-scale', String(state.fontScale));
    target.style.setProperty('--motion-scale', reduceMotion ? '0' : '1');
    for (const [name, value] of HIGH_CONTRAST_VARS) {
      if (state.highContrast) target.style.setProperty(name, value);
      else target.style.removeProperty(name);
    }
    target.setAttribute('data-contrast', state.highContrast ? 'high' : 'normal');
    target.setAttribute('data-motion', reduceMotion ? 'reduce' : 'full');
    target.setAttribute(SPEECH_OUTPUT_ATTR, state.speechOutput);
  }

  function emit(): void {
    for (const handler of [...listeners]) safeCall('subscribe', () => handler({ ...state }));
  }

  /** Lưu theo hàng đợi để thứ tự ghi đúng thứ tự gọi; lỗi lưu không làm hỏng set(). */
  function persist(patch: Partial<Settings>): Promise<void> {
    saveChain = saveChain
      .then(() => store.save(patch))
      .then(() => undefined, (error: unknown) => log.warn('Không lưu được cài đặt:', error));
    return saveChain;
  }

  return {
    async load(): Promise<Settings> {
      try {
        state = sanitize(await store.load(), DEFAULT_SETTINGS);
      } catch (error) {
        log.warn('Không nạp được cài đặt, giữ giá trị hiện có:', error);
      }
      if (!contrastChosen && !state.highContrast && prefers(QUERY_CONTRAST_MORE)) state = { ...state, highContrast: true };
      apply();
      emit();
      return { ...state };
    },

    get(): Settings {
      return { ...state };
    },

    async set(p: Partial<Settings>): Promise<Settings> {
      if (p.highContrast !== undefined) contrastChosen = true;
      const next = sanitize({ ...state, ...p }, state);
      const changed = diff(state, next);
      if (Object.keys(changed).length === 0) return { ...state };
      state = next;
      apply();
      emit();
      for (const ack of acksFor(changed)) safeCall('onAck', () => onAck(ack));
      await persist(changed);
      return { ...state };
    },

    subscribe(h: (s: Settings) => void): () => void {
      listeners.add(h);
      return () => {
        listeners.delete(h);
      };
    },
  };
}