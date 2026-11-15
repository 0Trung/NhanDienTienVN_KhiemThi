import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/config/app-config';
import type {
  AppErrorCode, Denomination, GuidanceCode, RecognitionResult, SettingAck, Settings, SpeechIntent,
} from '../../src/contracts';
import { AUDIO_KEYS, buildPrompt, SPEECH_PRIORITY } from '../../src/voice/prompt-manager';
import type { AudioKey } from '../../src/voice/prompt-manager';

const DETAILED: Settings = { ...DEFAULT_SETTINGS, verbosity: 'DETAILED' };
const BRIEF: Settings = { ...DEFAULT_SETTINGS, verbosity: 'BRIEF' };
const CAVEAT = 'Tổng này chỉ tính các tờ tôi nhìn thấy.';

function makeResult(denominations: Denomination[], overrides: Partial<RecognitionResult> = {}): RecognitionResult {
  const total = denominations.reduce((sum, d) => sum + d, 0);
  return {
    status: denominations.length === 1 ? 'CONFIDENT_SINGLE' : 'CONFIDENT_MULTI',
    count: denominations.length, denominations, total, formattedTotal: `${total} đồng`, timestamp: 0, ...overrides,
  };
}

/* Bảng kiểu Record: hợp đồng thêm mã mới mà bảng chưa có thì test lỗi biên dịch. */
const GUIDANCE: Record<GuidanceCode, string> = {
  NO_MONEY: 'Chưa nhận diện được tiền. Hãy đưa tiền đến trước camera.',
  TOO_FAR: 'Hãy đưa tiền lại gần camera hơn.',
  PARTIAL_IN_FRAME: 'Hãy đưa toàn bộ tờ tiền vào khung hình.',
  BLUR: 'Hình ảnh chưa rõ. Hãy giữ điện thoại yên.',
  LOW_LIGHT: 'Ánh sáng yếu. Hãy bật đèn hỗ trợ hoặc chuyển đến nơi sáng hơn.',
  LOW_CONFIDENCE: 'Tôi chưa nhận dạng rõ tờ tiền. Hãy duỗi phẳng tờ tiền và đưa gần camera hơn.',
  CLASS_CONFLICT: 'Tôi chưa phân biệt được mệnh giá. Hãy giữ tờ tiền thẳng và rõ hơn.',
  OVERLAP: 'Các tờ tiền có vẻ đang chồng lên nhau. Hãy tách chúng ra.',
  HOLD_STEADY: 'Hãy giữ tiền yên trước camera.',
  MULTI_NOT_ALLOWED: 'Hãy đưa từng tờ một.',
};
const GUIDANCE_AUDIO: Partial<Record<GuidanceCode, AudioKey>> = { NO_MONEY: 'no-money', LOW_LIGHT: 'low-light', BLUR: 'blur' };
const ERRORS: Record<AppErrorCode, AudioKey | undefined> = {
  UNSUPPORTED_BROWSER: undefined, CAMERA_PERMISSION_DENIED: 'camera-error', CAMERA_NOT_FOUND: undefined,
  CAMERA_IN_USE: undefined, CAMERA_FAILED: undefined, MODEL_MISSING: 'model-error', MODEL_CORRUPT: undefined,
  MODEL_INIT_FAILED: undefined, INFERENCE_FAILED: undefined, TTS_UNAVAILABLE: undefined,
  TTS_NO_VIETNAMESE_VOICE: 'no-vi-voice', STORAGE_FAILED: undefined, OFFLINE_NOT_READY: 'model-error',
};
const ACK_FAMILY: Record<SettingAck, string> = {
  VOICE_ON: 'VOICE', VIBRATION_ON: 'VIBRATION', VIBRATION_OFF: 'VIBRATION', TORCH_ON: 'TORCH', TORCH_OFF: 'TORCH',
  TORCH_UNSUPPORTED: 'TORCH', RATE_SLOW: 'RATE', RATE_NORMAL: 'RATE', RATE_FAST: 'RATE',
  VERBOSITY_BRIEF: 'VERBOSITY', VERBOSITY_DETAILED: 'VERBOSITY',
};
const GUIDANCE_CODES = Object.keys(GUIDANCE) as GuidanceCode[];
const ERROR_CODES = Object.keys(ERRORS) as AppErrorCode[];
const ACK_CODES = Object.keys(ACK_FAMILY) as SettingAck[];

describe('buildPrompt: câu cố định', () => {
  it.each<[SpeechIntent, string, AudioKey | undefined]>([
    [{ kind: 'WELCOME' }, 'Xin chào! Hãy đưa tiền đến trước camera.', 'welcome'],
    [
      { kind: 'PERMISSION_PRIMER' },
      'Ứng dụng cần dùng camera để nhận dạng tiền. Hãy chọn Cho phép trên hộp thoại sắp hiện ra.',
      'permission-primer',
    ],
    [{ kind: 'CAMERA_READY' }, 'Camera đã sẵn sàng, hãy đưa tiền vào trước camera.', 'camera-ready'],
    [{ kind: 'REPLAY_EMPTY' }, 'Hiện tại tôi chưa nhận dạng được tờ tiền nào.', undefined],
  ])('%j', (intent, text, audioKey) => {
    const prompt = buildPrompt(intent, DETAILED);
    expect(prompt.text).toBe(text);
    expect(prompt.audioKey).toBe(audioKey);
    expect(prompt.priority).toBe(0);
  });
});

describe('buildPrompt: GUIDANCE (mọi mã đều có câu)', () => {
  it.each(GUIDANCE_CODES.map((code): [GuidanceCode, string] => [code, GUIDANCE[code]]))('%s', (code, text) => {
    const prompt = buildPrompt({ kind: 'GUIDANCE', code }, DETAILED);
    expect(prompt.text).toBe(text);
    expect(prompt.audioKey).toBe(GUIDANCE_AUDIO[code]);
    expect(prompt.priority).toBe(1);
    expect(prompt.supersedeKey).toBe('GUIDANCE'); // dùng chung để GUIDANCE mới thay GUIDANCE đang chờ
  });

  it('LOW_CONFIDENCE là lời hướng dẫn, không khẳng định tiền đang bị gấp', () => {
    expect(GUIDANCE.LOW_CONFIDENCE).not.toMatch(/gấp|nhăn|nát/);
  });
});

describe('buildPrompt: ERROR (mọi mã đều có câu nêu việc cần làm)', () => {
  it.each<[AppErrorCode, string]>([
    [
      'CAMERA_PERMISSION_DENIED',
      'Bạn chưa cấp quyền camera. Hãy mở Cài đặt của điện thoại, chọn Ứng dụng, chọn ứng dụng này rồi bật quyền Camera.',
    ],
    ['OFFLINE_NOT_READY', 'Ứng dụng thiếu dữ liệu nhận dạng. Hãy cài lại ứng dụng.'],
    ['MODEL_MISSING', 'Ứng dụng thiếu dữ liệu nhận dạng. Hãy cài lại ứng dụng.'],
    [
      'TTS_NO_VIETNAMESE_VOICE',
      'Điện thoại chưa có giọng đọc tiếng Việt. Hãy vào Cài đặt, Chuyển văn bản thành giọng nói, rồi tải dữ liệu giọng Tiếng Việt.',
    ],
  ])('%s khớp từng chữ với đặc tả', (code, text) => {
    expect(buildPrompt({ kind: 'ERROR', code }, DETAILED).text).toBe(text);
  });

  it.each(ERROR_CODES)('%s: có việc cần làm, ưu tiên 3, audioKey đúng', (code) => {
    const prompt = buildPrompt({ kind: 'ERROR', code }, DETAILED);
    expect(prompt.text).toContain('Hãy');
    expect(prompt.priority).toBe(3);
    expect(prompt.audioKey).toBe(ERRORS[code]);
  });

  it('mỗi mã lỗi có supersedeKey riêng', () => {
    const keys = ERROR_CODES.map((code) => buildPrompt({ kind: 'ERROR', code }, DETAILED).supersedeKey);
    expect(new Set(keys).size).toBe(ERROR_CODES.length);
  });
});

describe('buildPrompt: SETTING_ACK (mọi giá trị đều có câu)', () => {
  it.each(ACK_CODES)('%s: ưu tiên 0, khóa thay thế theo từng cài đặt', (what) => {
    const prompt = buildPrompt({ kind: 'SETTING_ACK', what }, DETAILED);
    expect(prompt.text.length).toBeGreaterThan(5);
    expect(prompt.priority).toBe(0);
    expect(prompt.supersedeKey).toBe(`SETTING_ACK:${ACK_FAMILY[what]}`);
  });
});

describe('buildPrompt: kết quả một tờ', () => {
  it.each<[string, Settings]>([['DETAILED', DETAILED], ['BRIEF', BRIEF]])('%s: chỉ nói mệnh giá', (_name, settings) => {
    const prompt = buildPrompt({ kind: 'RESULT', result: makeResult([50000]) }, settings);
    expect(prompt.text).toBe('Năm mươi nghìn đồng.');
    expect(prompt.priority).toBe(SPEECH_PRIORITY.RESULT);
    expect(prompt.supersedeKey).toBe('RESULT');
    expect(prompt.audioKey).toBeUndefined();
  });
});

describe('buildPrompt: kết quả nhiều tờ', () => {
  it.each<[string, Denomination[], string]>([
    [
      'đọc từng tờ khác mệnh giá',
      [20000, 50000, 100000],
      'Có ba tờ tiền. Một tờ hai mươi nghìn đồng. Một tờ năm mươi nghìn đồng. Một tờ một trăm nghìn đồng. ' +
        `Tổng cộng một trăm bảy mươi nghìn đồng. ${CAVEAT}`,
    ],
    [
      'nhóm các tờ cùng mệnh giá',
      [10000, 10000, 50000],
      `Có ba tờ tiền. Hai tờ mười nghìn đồng. Một tờ năm mươi nghìn đồng. Tổng cộng bảy mươi nghìn đồng. ${CAVEAT}`,
    ],
    [
      'nhóm theo thứ tự xuất hiện đầu tiên từ trái sang phải',
      [50000, 10000, 50000],
      `Có ba tờ tiền. Hai tờ năm mươi nghìn đồng. Một tờ mười nghìn đồng. Tổng cộng một trăm mười nghìn đồng. ${CAVEAT}`,
    ],
  ])('DETAILED: %s', (_name, denominations, text) => {
    expect(buildPrompt({ kind: 'RESULT', result: makeResult(denominations) }, DETAILED).text).toBe(text);
  });

  it('BRIEF: chỉ đọc tổng, không có câu lưu ý', () => {
    const prompt = buildPrompt({ kind: 'RESULT', result: makeResult([20000, 50000, 100000]) }, BRIEF);
    expect(prompt.text).toBe('Một trăm bảy mươi nghìn đồng.');
  });
});

describe('buildPrompt: REPLAY', () => {
  it.each<[string, Settings, Denomination[]]>([
    ['một tờ DETAILED', DETAILED, [50000]],
    ['một tờ BRIEF', BRIEF, [50000]],
    ['nhiều tờ DETAILED', DETAILED, [10000, 10000, 50000]],
    ['nhiều tờ BRIEF', BRIEF, [10000, 10000, 50000]],
  ])('%s: cùng câu với RESULT, ưu tiên 2, khóa REPLAY', (_name, settings, ds) => {
    const result = makeResult(ds);
    const replay = buildPrompt({ kind: 'REPLAY', result }, settings);
    expect(replay.text).toBe(buildPrompt({ kind: 'RESULT', result }, settings).text);
    expect(replay.priority).toBe(2);
    expect(replay.supersedeKey).toBe('REPLAY');
  });

  it('REPLAY_EMPTY dùng chung khóa REPLAY', () => {
    expect(buildPrompt({ kind: 'REPLAY_EMPTY' }, DETAILED).supersedeKey).toBe('REPLAY');
  });
});

describe('buildPrompt: Fail Safe', () => {
  it.each<[string, RecognitionResult]>([
    ['không có tờ nào', makeResult([], { count: 0, total: 0 })],
    ['count lệch số mệnh giá', makeResult([20000, 50000], { count: 3 })],
    ['total lệch tổng các mệnh giá', makeResult([20000, 50000], { total: 80000 })],
    ['total là NaN', makeResult([20000], { total: Number.NaN })],
    ['mệnh giá không hợp lệ', makeResult([30000 as unknown as Denomination])],
  ])('kết quả không nhất quán (%s) → ném RangeError, không đọc gì', (_name, result) => {
    expect(() => buildPrompt({ kind: 'RESULT', result }, DETAILED)).toThrow(RangeError);
    expect(() => buildPrompt({ kind: 'REPLAY', result }, DETAILED)).toThrow(RangeError);
  });

  it.each([
    { kind: 'GUIDANCE', code: 'KHONG_CO' },
    { kind: 'ERROR', code: 'KHONG_CO' },
    { kind: 'SETTING_ACK', what: 'KHONG_CO' },
    { kind: 'KHONG_CO' },
  ])('ý định lạ %j → ném RangeError, không bao giờ đọc chữ "undefined"', (intent) => {
    expect(() => buildPrompt(intent as unknown as SpeechIntent, DETAILED)).toThrow(RangeError);
  });
});

describe('buildPrompt: tính chất chung của mọi câu nói', () => {
  const sample = makeResult([20000, 50000, 100000]);
  const intents: SpeechIntent[] = [
    { kind: 'WELCOME' }, { kind: 'PERMISSION_PRIMER' }, { kind: 'CAMERA_READY' }, { kind: 'REPLAY_EMPTY' },
    { kind: 'RESULT', result: sample }, { kind: 'REPLAY', result: makeResult([50000]) },
    ...GUIDANCE_CODES.map((code): SpeechIntent => ({ kind: 'GUIDANCE', code })),
    ...ERROR_CODES.map((code): SpeechIntent => ({ kind: 'ERROR', code })),
    ...ACK_CODES.map((what): SpeechIntent => ({ kind: 'SETTING_ACK', what })),
  ];
  const prompts = intents.map((intent) => buildPrompt(intent, DETAILED));

  it('câu sạch: không thừa khoảng trắng, không còn chữ số, không "ngàn", kết thúc bằng dấu câu', () => {
    for (const { text } of prompts) {
      expect(text).toBe(text.trim());
      expect(text).not.toContain('  ');
      expect(text).not.toMatch(/\d/);
      expect(text).not.toContain('ngàn');
      expect(text).toMatch(/[.!?]$/);
    }
  });

  it('chín khóa âm thanh đều được dùng cho đúng một câu cố định', () => {
    const used = new Set(prompts.map((p) => p.audioKey).filter((k) => k !== undefined));
    expect([...used].sort()).toEqual([...AUDIO_KEYS].sort());
  });

  it('ưu tiên: ERROR 3, RESULT và REPLAY 2, GUIDANCE 1, còn lại 0', () => {
    expect(SPEECH_PRIORITY).toEqual({ ERROR: 3, RESULT: 2, REPLAY: 2, GUIDANCE: 1, OTHER: 0 });
  });
});