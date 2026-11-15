import { DEFAULT_SETTINGS } from '../config/app-config';
import type { ISettingsStore, Settings } from '../contracts';
import { createLogger } from '../utils/logger';
import { clamp } from '../utils/math';
import { getPlatform } from '../utils/platform';
import { createDefaultPorts, createMemoryPort } from './key-value-port';
import type { KeyValuePort } from './key-value-port';
import { assertNoImageData } from './privacy-guard';

const log = createLogger('settings-store');

/** Khóa duy nhất chứa toàn bộ cài đặt dưới dạng một chuỗi JSON. */
export const SETTINGS_STORAGE_KEY = 'moneyreader.settings';
/** Phiên bản cấu trúc cài đặt hiện tại (khớp Settings.schemaVersion). */
export const CURRENT_SCHEMA_VERSION = 1;

/* Giới hạn theo hợp đồng Settings (AppConfig chưa có mục này nên đặt hằng số có tên tại đây). */
const FONT_SCALE_MIN = 1;
const FONT_SCALE_MAX = 2;
const SPEECH_RATES: readonly number[] = [0.8, 1.0, 1.2];
const MODEL_VERSION_MAX_LENGTH = 32;

export type RawSettings = Record<string, unknown>;
/** Bước nâng cấp dữ liệu từ phiên bản n lên n+1. */
export type MigrationStep = (data: RawSettings) => RawSettings;
export type MigrationSteps = Readonly<Record<number, MigrationStep>>;

/** Khóa là phiên bản NGUỒN. Phiên bản 0 = dữ liệu chưa ghi schemaVersion, giả định cùng khóa với phiên bản 1. */
export const MIGRATIONS: MigrationSteps = {
  0: (data) => data,
};

function isRecord(v: unknown): v is RawSettings {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readVersion(data: RawSettings): number {
  const v = data.schemaVersion;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * Đưa dữ liệu đã lưu (mọi phiên bản cũ) lên phiên bản `target`, chạy lần lượt từng bước.
 * Dữ liệu do bản app mới hơn ghi (version > target) được giữ nguyên để sanitizeSettings lọc theo khóa đã biết.
 * Không chứng nhận giá trị hợp lệ: việc đó của sanitizeSettings.
 */
export function migrate(
  raw: unknown,
  steps: MigrationSteps = MIGRATIONS,
  target: number = CURRENT_SCHEMA_VERSION,
): RawSettings {
  let data: RawSettings = isRecord(raw) ? { ...raw } : {};
  let version = readVersion(data);
  if (version > target) log.warn('Cài đặt do phiên bản app mới hơn ghi, chỉ giữ các khóa đã biết:', version);
  for (; version < target; version += 1) {
    const step = steps[version];
    if (step) data = step(data);
  }
  return { ...data, schemaVersion: target };
}

const pickBool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

function pickOne<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d;
}

/** speechRate chỉ nhận 0.8, 1.0, 1.2: số khác được kẹp về mức gần nhất, sai kiểu thì về mặc định. */
function pickRate(v: unknown, d: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return d;
  return SPEECH_RATES.reduce<number>((best, rate) => (Math.abs(rate - v) < Math.abs(best - v) ? rate : best), d);
}

function pickScale(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, FONT_SCALE_MIN, FONT_SCALE_MAX) : d;
}

function pickVersion(v: unknown, d: string): string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= MODEL_VERSION_MAX_LENGTH ? v : d;
}

/**
 * Danh sách trắng khóa theo Settings: khóa lạ bị loại, kiểu sai về giá trị mặc định (DEFAULT_SETTINGS),
 * giá trị số được kẹp (fontScale 1..2, speechRate 0.8/1.0/1.2). Luôn trả đối tượng mới, đủ khóa.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const r: RawSettings = isRecord(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    voiceEnabled: pickBool(r.voiceEnabled, d.voiceEnabled),
    voiceLanguage: d.voiceLanguage,
    speechRate: pickRate(r.speechRate, d.speechRate),
    verbosity: pickOne(r.verbosity, ['BRIEF', 'DETAILED'], d.verbosity),
    speechOutput: pickOne(r.speechOutput, ['APP_TTS', 'SCREEN_READER'], d.speechOutput),
    vibrationEnabled: pickBool(r.vibrationEnabled, d.vibrationEnabled),
    torchEnabled: pickBool(r.torchEnabled, d.torchEnabled),
    fontScale: pickScale(r.fontScale, d.fontScale),
    highContrast: pickBool(r.highContrast, d.highContrast),
    autoStartCamera: pickBool(r.autoStartCamera, d.autoStartCamera),
    modelVersion: pickVersion(r.modelVersion, d.modelVersion),
  };
}

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_SETTINGS));
const noop = (): void => undefined;

/** Chỉ giữ khóa đã biết và giá trị khác undefined (Partial cho phép undefined tường minh, không được coi là "xóa về mặc định"). */
function pickKnown(patch: unknown): RawSettings {
  const out: RawSettings = {};
  if (!isRecord(patch)) return out;
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!KNOWN_KEYS.has(key)) dropped.push(key);
    else if (value !== undefined) out[key] = value;
  }
  if (dropped.length > 0) log.warn('Bỏ qua khóa lạ trong cài đặt:', dropped.join(', '));
  return out;
}

/**
 * Kho cài đặt trên chuỗi cổng `ports` (ưu tiên từ đầu đến cuối). Một cổng bộ nhớ luôn được thêm cuối chuỗi
 * nên cổng nào ném lỗi thì kho vẫn chạy được trong phiên.
 * - load: đọc từ cổng đầu tiên có dữ liệu; hỏng hay trống thì dùng mặc định.
 * - save: gộp rồi ghi vào cổng đầu tiên ghi được. Các thao tác được xếp hàng để hai lần save liền nhau không ghi đè nhau.
 * - reset: xóa ở mọi cổng.
 * Mọi lần save đều qua assertNoImageData (ném AppError STORAGE_FAILED nếu bản vá chứa ảnh).
 */
export function createSettingsStoreWith(ports: readonly KeyValuePort[]): ISettingsStore {
  const chain: readonly KeyValuePort[] = [...ports, createMemoryPort()];
  let tail: Promise<unknown> = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.then(noop, noop);
    return run;
  }

  async function readStored(): Promise<string | null> {
    for (const port of chain) {
      try {
        const text = await port.get(SETTINGS_STORAGE_KEY);
        if (typeof text === 'string') return text;
      } catch (e) {
        log.warn('Không đọc được một kho lưu, thử kho kế tiếp', e);
      }
    }
    return null;
  }

  async function readCurrent(): Promise<Settings> {
    const text = await readStored();
    if (text === null) return { ...DEFAULT_SETTINGS };
    try {
      const parsed: unknown = JSON.parse(text);
      return sanitizeSettings(migrate(parsed));
    } catch (e) {
      log.warn('Cài đặt đã lưu bị hỏng, dùng mặc định', e);
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function writeStored(settings: Settings): Promise<void> {
    const text = JSON.stringify(settings);
    for (const port of chain) {
      try {
        await port.set(SETTINGS_STORAGE_KEY, text);
        return;
      } catch (e) {
        log.warn('Không ghi được vào một kho lưu, thử kho kế tiếp', e);
      }
    }
  }

  return {
    load: () => serialize(readCurrent),

    async save(patch: Partial<Settings>): Promise<Settings> {
      assertNoImageData(patch);
      const clean = pickKnown(patch);
      return serialize(async () => {
        const merged = sanitizeSettings({ ...(await readCurrent()), ...clean });
        await writeStored(merged);
        return { ...merged };
      });
    },

    reset: () =>
      serialize(async () => {
        for (const port of chain) {
          try {
            await port.remove(SETTINGS_STORAGE_KEY);
          } catch (e) {
            log.warn('Không xóa được một kho lưu', e);
          }
        }
        return { ...DEFAULT_SETTINGS };
      }),
  };
}

/** Kho cài đặt dùng trong app: Preferences khi chạy trong APK, localStorage dự phòng, rồi bộ nhớ trong. */
export function createSettingsStore(): ISettingsStore {
  return createSettingsStoreWith(createDefaultPorts({ native: getPlatform() === 'android-native' }));
}