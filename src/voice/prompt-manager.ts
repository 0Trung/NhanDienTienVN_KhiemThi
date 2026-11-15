import { isDenomination } from '../config/denominations';
import type {
  AppErrorCode,
  Denomination,
  GuidanceCode,
  RecognitionResult,
  SettingAck,
  Settings,
  SpeechIntent,
} from '../contracts';
import { denominationToSpeech, moneyToSpeech, numberToVietnameseWords } from './vietnamese-number';

/** Mức ưu tiên của câu nói. Số lớn hơn thì được nói trước và được phép ngắt số nhỏ hơn. */
export const SPEECH_PRIORITY = { ERROR: 3, RESULT: 2, REPLAY: 2, GUIDANCE: 1, OTHER: 0 } as const;
export type SpeechPriority = 0 | 1 | 2 | 3;

/** Khóa các file âm thanh ghi sẵn trong public/audio (mỗi khóa ứng với đúng một câu cố định). */
export const AUDIO_KEYS = [
  'welcome',
  'permission-primer',
  'camera-ready',
  'no-money',
  'low-light',
  'blur',
  'camera-error',
  'model-error',
  'no-vi-voice',
] as const;
export type AudioKey = (typeof AUDIO_KEYS)[number];

export interface Prompt {
  /** Câu sẽ đọc: tiếng Việt, viết hoa chữ đầu, số đã đọc thành chữ, mỗi câu kết thúc bằng dấu câu. */
  text: string;
  /** Khóa file mp3 ghi sẵn; chỉ có ở câu cố định có thu âm. */
  audioKey?: AudioKey;
  priority: SpeechPriority;
  /** Mục mới có cùng supersedeKey sẽ thay mục đang chờ trong hàng đợi. */
  supersedeKey: string;
}

/* ───── Câu cố định (khớp từng chữ với đặc tả) ───── */

const WELCOME_TEXT = 'Xin chào! Hãy đưa tiền đến trước camera.';
const PERMISSION_PRIMER_TEXT =
  'Ứng dụng cần dùng camera để nhận dạng tiền. Hãy chọn Cho phép trên hộp thoại sắp hiện ra.';
const CAMERA_READY_TEXT = 'Camera đã sẵn sàng, hãy đưa tiền vào trước camera.';
const REPLAY_EMPTY_TEXT = 'Hiện tại tôi chưa nhận dạng được tờ tiền nào.';
const TOTAL_CAVEAT_TEXT = 'Tổng này chỉ tính các tờ tôi nhìn thấy.';

const GUIDANCE_TEXT: Readonly<Record<GuidanceCode, string>> = {
  NO_MONEY: 'Chưa nhận diện được tiền. Hãy đưa tiền đến trước camera.',
  TOO_FAR: 'Hãy đưa tiền lại gần camera hơn.',
  PARTIAL_IN_FRAME: 'Hãy đưa toàn bộ tờ tiền vào khung hình.',
  BLUR: 'Hình ảnh chưa rõ. Hãy giữ điện thoại yên.',
  LOW_LIGHT: 'Ánh sáng yếu. Hãy bật đèn hỗ trợ hoặc chuyển đến nơi sáng hơn.',
  // Đây là LỜI HƯỚNG DẪN, KHÔNG khẳng định tiền đang bị gấp.
  LOW_CONFIDENCE: 'Tôi chưa nhận dạng rõ tờ tiền. Hãy duỗi phẳng tờ tiền và đưa gần camera hơn.',
  CLASS_CONFLICT: 'Tôi chưa phân biệt được mệnh giá. Hãy giữ tờ tiền thẳng và rõ hơn.',
  OVERLAP: 'Các tờ tiền có vẻ đang chồng lên nhau. Hãy tách chúng ra.',
  HOLD_STEADY: 'Hãy giữ tiền yên trước camera.',
  MULTI_NOT_ALLOWED: 'Hãy đưa từng tờ một.',
};

const GUIDANCE_AUDIO: Readonly<Partial<Record<GuidanceCode, AudioKey>>> = {
  NO_MONEY: 'no-money',
  LOW_LIGHT: 'low-light',
  BLUR: 'blur',
};

const MISSING_MODEL_TEXT = 'Ứng dụng thiếu dữ liệu nhận dạng. Hãy cài lại ứng dụng.';

/** Mỗi mã lỗi một câu nêu việc cần làm. */
const ERROR_TEXT: Readonly<Record<AppErrorCode, string>> = {
  UNSUPPORTED_BROWSER:
    'Điện thoại chưa hỗ trợ đủ tính năng cần thiết. Hãy cập nhật WebView trong cửa hàng ứng dụng rồi mở lại ứng dụng.',
  CAMERA_PERMISSION_DENIED:
    'Bạn chưa cấp quyền camera. Hãy mở Cài đặt của điện thoại, chọn Ứng dụng, chọn ứng dụng này rồi bật quyền Camera.',
  CAMERA_NOT_FOUND: 'Không tìm thấy camera trên điện thoại. Hãy thử lại trên một điện thoại có camera sau.',
  CAMERA_IN_USE: 'Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi mở lại ứng dụng này.',
  CAMERA_FAILED: 'Không mở được camera. Hãy đóng ứng dụng rồi mở lại.',
  MODEL_MISSING: MISSING_MODEL_TEXT,
  MODEL_CORRUPT: 'Dữ liệu nhận dạng bị hỏng. Hãy cài lại ứng dụng.',
  MODEL_INIT_FAILED: 'Không khởi động được bộ nhận dạng. Hãy đóng ứng dụng rồi mở lại.',
  INFERENCE_FAILED: 'Nhận dạng gặp lỗi. Hãy thử lại, nếu vẫn lỗi thì đóng ứng dụng rồi mở lại.',
  TTS_UNAVAILABLE:
    'Giọng đọc của điện thoại đang không hoạt động. Hãy kiểm tra mục Chuyển văn bản thành giọng nói trong Cài đặt rồi mở lại ứng dụng.',
  TTS_NO_VIETNAMESE_VOICE:
    'Điện thoại chưa có giọng đọc tiếng Việt. Hãy vào Cài đặt, Chuyển văn bản thành giọng nói, rồi tải dữ liệu giọng Tiếng Việt.',
  STORAGE_FAILED: 'Không lưu được cài đặt. Hãy kiểm tra bộ nhớ điện thoại còn trống rồi thử lại.',
  OFFLINE_NOT_READY: MISSING_MODEL_TEXT,
};

/** Chỉ ba câu lỗi có thu âm sẵn (nội dung mp3 phải khớp câu tương ứng ở trên). */
const ERROR_AUDIO: Readonly<Partial<Record<AppErrorCode, AudioKey>>> = {
  CAMERA_PERMISSION_DENIED: 'camera-error',
  MODEL_MISSING: 'model-error',
  OFFLINE_NOT_READY: 'model-error',
  TTS_NO_VIETNAMESE_VOICE: 'no-vi-voice',
};

const SETTING_ACK_TEXT: Readonly<Record<SettingAck, string>> = {
  VOICE_ON: 'Đã bật giọng nói.',
  VIBRATION_ON: 'Đã bật rung.',
  VIBRATION_OFF: 'Đã tắt rung.',
  TORCH_ON: 'Đã bật đèn hỗ trợ.',
  TORCH_OFF: 'Đã tắt đèn hỗ trợ.',
  TORCH_UNSUPPORTED: 'Điện thoại này không bật được đèn hỗ trợ.',
  RATE_SLOW: 'Đã đặt tốc độ đọc chậm.',
  RATE_NORMAL: 'Đã đặt tốc độ đọc bình thường.',
  RATE_FAST: 'Đã đặt tốc độ đọc nhanh.',
  VERBOSITY_BRIEF: 'Đã chọn chế độ đọc ngắn gọn.',
  VERBOSITY_DETAILED: 'Đã chọn chế độ đọc chi tiết.',
};

/** Các xác nhận cùng một cài đặt dùng chung khóa thay thế: xác nhận mới thay xác nhận cũ đang chờ. */
const SETTING_ACK_FAMILY: Readonly<Record<SettingAck, string>> = {
  VOICE_ON: 'VOICE',
  VIBRATION_ON: 'VIBRATION',
  VIBRATION_OFF: 'VIBRATION',
  TORCH_ON: 'TORCH',
  TORCH_OFF: 'TORCH',
  TORCH_UNSUPPORTED: 'TORCH',
  RATE_SLOW: 'RATE',
  RATE_NORMAL: 'RATE',
  RATE_FAST: 'RATE',
  VERBOSITY_BRIEF: 'VERBOSITY',
  VERBOSITY_DETAILED: 'VERBOSITY',
};

/* ───── Hàm phụ ───── */

/** Tra bảng câu; thiếu thì ném lỗi để KHÔNG BAO GIỜ đọc ra chữ "undefined". */
function lookup<K extends string>(table: Readonly<Record<K, string>>, key: K, what: string): string {
  const text = table[key];
  if (typeof text !== 'string' || text === '') {
    throw new RangeError(`buildPrompt: ${what} không được hỗ trợ: ${String(key)}`);
  }
  return text;
}

function capitalize(text: string): string {
  return text === '' ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Câu một mệnh đề: viết hoa chữ đầu và thêm dấu chấm cuối. */
function sentence(text: string): string {
  return `${capitalize(text)}.`;
}

function makePrompt(text: string, priority: SpeechPriority, supersedeKey: string, audioKey?: AudioKey): Prompt {
  return audioKey === undefined ? { text, priority, supersedeKey } : { text, audioKey, priority, supersedeKey };
}

/**
 * Kiểm tra kết quả nhất quán trước khi đọc: có tờ tiền, count khớp số mệnh giá, total khớp tổng các mệnh giá,
 * mọi mệnh giá hợp lệ. Sai một chỗ là ném RangeError (Fail Safe: thà không đọc còn hơn đọc sai số tiền).
 */
function assertConsistent(result: RecognitionResult): void {
  const { denominations } = result;
  if (denominations.length === 0) throw new RangeError('buildPrompt: kết quả không có tờ tiền nào');
  let sum = 0;
  for (const d of denominations) {
    if (!isDenomination(d)) throw new RangeError(`buildPrompt: mệnh giá không hợp lệ: ${String(d)}`);
    sum += d;
  }
  if (result.count !== denominations.length) {
    throw new RangeError(`buildPrompt: count (${String(result.count)}) khác số mệnh giá (${denominations.length})`);
  }
  if (result.total !== sum) {
    throw new RangeError(`buildPrompt: total (${String(result.total)}) khác tổng các mệnh giá (${sum})`);
  }
}

interface DenominationGroup {
  denomination: Denomination;
  count: number;
}

/** Nhóm các tờ cùng mệnh giá, theo thứ tự xuất hiện đầu tiên từ trái sang phải. */
function groupByDenomination(denominations: readonly Denomination[]): DenominationGroup[] {
  const groups: DenominationGroup[] = [];
  for (const d of denominations) {
    const existing = groups.find((g) => g.denomination === d);
    if (existing === undefined) groups.push({ denomination: d, count: 1 });
    else existing.count += 1;
  }
  return groups;
}

/** Dựng câu đọc kết quả theo độ chi tiết. Dùng chung cho RESULT và REPLAY. */
function buildResultText(result: RecognitionResult, verbosity: Settings['verbosity']): string {
  assertConsistent(result);
  const [first] = result.denominations;

  if (result.denominations.length === 1 && first !== undefined) {
    return sentence(denominationToSpeech(first));
  }
  if (verbosity === 'BRIEF') {
    return sentence(moneyToSpeech(result.total));
  }

  const parts = [sentence(`có ${numberToVietnameseWords(result.denominations.length)} tờ tiền`)];
  for (const group of groupByDenomination(result.denominations)) {
    parts.push(sentence(`${numberToVietnameseWords(group.count)} tờ ${denominationToSpeech(group.denomination)}`));
  }
  parts.push(sentence(`tổng cộng ${moneyToSpeech(result.total)}`), TOTAL_CAVEAT_TEXT);
  return parts.join(' ');
}

/**
 * Dựng câu nói cho một ý định nói.
 * Ném RangeError khi dữ liệu không đủ tin cậy để đọc (kết quả không nhất quán, mã không có câu);
 * nơi gọi phải bắt lỗi và KHÔNG đọc gì thay vì đoán.
 */
export function buildPrompt(intent: SpeechIntent, settings: Pick<Settings, 'verbosity'>): Prompt {
  switch (intent.kind) {
    case 'WELCOME':
      return makePrompt(WELCOME_TEXT, SPEECH_PRIORITY.OTHER, 'WELCOME', 'welcome');
    case 'PERMISSION_PRIMER':
      return makePrompt(PERMISSION_PRIMER_TEXT, SPEECH_PRIORITY.OTHER, 'PERMISSION_PRIMER', 'permission-primer');
    case 'CAMERA_READY':
      return makePrompt(CAMERA_READY_TEXT, SPEECH_PRIORITY.OTHER, 'CAMERA_READY', 'camera-ready');
    case 'GUIDANCE':
      return makePrompt(
        lookup(GUIDANCE_TEXT, intent.code, 'mã hướng dẫn'),
        SPEECH_PRIORITY.GUIDANCE,
        'GUIDANCE',
        GUIDANCE_AUDIO[intent.code],
      );
    case 'RESULT':
      return makePrompt(buildResultText(intent.result, settings.verbosity), SPEECH_PRIORITY.RESULT, 'RESULT');
    case 'REPLAY':
      return makePrompt(buildResultText(intent.result, settings.verbosity), SPEECH_PRIORITY.REPLAY, 'REPLAY');
    case 'REPLAY_EMPTY':
      return makePrompt(REPLAY_EMPTY_TEXT, SPEECH_PRIORITY.OTHER, 'REPLAY');
    case 'ERROR':
      return makePrompt(
        lookup(ERROR_TEXT, intent.code, 'mã lỗi'),
        SPEECH_PRIORITY.ERROR,
        `ERROR:${intent.code}`,
        ERROR_AUDIO[intent.code],
      );
    case 'SETTING_ACK':
      return makePrompt(
        lookup(SETTING_ACK_TEXT, intent.what, 'xác nhận cài đặt'),
        SPEECH_PRIORITY.OTHER,
        `SETTING_ACK:${lookup(SETTING_ACK_FAMILY, intent.what, 'xác nhận cài đặt')}`,
      );
    default: {
      const unsupported: never = intent;
      throw new RangeError(`buildPrompt: ý định không được hỗ trợ: ${JSON.stringify(unsupported)}`);
    }
  }
}