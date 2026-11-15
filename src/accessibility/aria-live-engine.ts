/**
 * Engine "aria-live" (F4): đọc bằng TRÌNH ĐỌC MÀN HÌNH của người dùng (TalkBack, VoiceOver) thay cho giọng của app.
 * speak() ghi chữ vào một vùng aria-live="assertive" được ẩn khỏi mắt bằng clip (KHÔNG dùng display:none hay
 * aria-hidden vì trình đọc màn hình sẽ bỏ qua). Câu giống hệt câu trước vẫn được đọc lại: vùng bị xóa trước,
 * rồi ghi lại sau REWRITE_DELAY_MS. Nhịp 0 ms hay một khung hình có thể bị gộp thành "không đổi"; 100 ms là
 * giá trị các thư viện trợ năng thường dùng. Cần thử TalkBack thật để chỉnh.
 *
 * GIỚI HẠN (đã biết, không khắc phục được từ phía web):
 * 1. Không biết lúc nào trình đọc màn hình nói xong, nên onEnd bắn theo THỜI GIAN ƯỚC LƯỢNG
 *    max(MIN_SPEECH_MS, độ dài chữ × MS_PER_CHAR ÷ rate), tính từ lúc gọi speak(). Ước lượng sai thì hai câu có thể
 *    chồng nhau hoặc có khoảng lặng thừa.
 * 2. Không điều khiển được giọng, tốc độ, cao độ: rate chỉ dùng để ước lượng thời gian, audioKey bị bỏ qua.
 *    Giọng do cài đặt trình đọc màn hình của người dùng quyết định.
 * 3. capabilities.vietnameseVoice và offlineVietnamese luôn true theo GIẢ ĐỊNH (không kiểm chứng được); available
 *    chỉ nói "có DOM để ghi", không nói trình đọc màn hình có đang bật hay không. Nếu nó tắt thì KHÔNG có tiếng nào:
 *    P11 chỉ nên chọn engine này khi speechOutput là SCREEN_READER.
 * 4. Vùng assertive có thể cắt ngang câu trình đọc màn hình đang nói; đó là chủ ý (kết quả phải đến ngay).
 * 5. cancel() chỉ xóa vùng; câu trình đọc màn hình đã bắt đầu nói có thể vẫn nói nốt.
 */
import { AppError } from '../contracts';
import type { ITtsEngine, TtsCapabilities } from '../contracts';
import { ROLE_ATTR, safeCall, setStyles } from './a11y-shared';

/** Thời gian đọc ước lượng cho mỗi ký tự ở rate 1.0 (ms). */
export const MS_PER_CHAR = 70;
/** Thời gian đọc ước lượng tối thiểu (ms), kể cả câu rất ngắn. */
export const MIN_SPEECH_MS = 800;
/** Độ trễ giữa lúc xóa vùng và lúc ghi lại chữ (ms). */
export const REWRITE_DELAY_MS = 100;

const VISUALLY_HIDDEN: Readonly<Record<string, string>> = {
  position: 'absolute', width: '1px', height: '1px', margin: '-1px', padding: '0', border: '0',
  overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', 'clip-path': 'inset(50%)', 'white-space': 'nowrap',
};

/** Thời gian (ms) trình đọc màn hình ước chừng cần để đọc xong text ở tốc độ rate. rate không hợp lệ thì coi là 1. */
export function estimateSpeechMs(text: string, rate: number): number {
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return Math.max(MIN_SPEECH_MS, (text.length * MS_PER_CHAR) / safeRate);
}

type Timer = ReturnType<typeof setTimeout>;
interface Utterance { write: Timer | null; end: Timer | null }

export function createAriaLiveEngine(o?: { root?: HTMLElement }): ITtsEngine {
  let region: HTMLElement | null = null;
  let active: Utterance | null = null;

  const hasDom = (): boolean => o?.root !== undefined || typeof document !== 'undefined';

  function ensureRegion(): HTMLElement | null {
    if (region !== null && region.isConnected) return region;
    const host = o?.root ?? (typeof document === 'undefined' ? null : document.body ?? null);
    if (host === null) return null;
    // Vùng phải có sẵn trong DOM TRƯỚC khi nội dung đổi thì trình đọc màn hình mới theo dõi nó: dựng ở init().
    const el = host.ownerDocument.createElement('div');
    el.setAttribute(ROLE_ATTR, 'live-region');
    el.setAttribute('aria-live', 'assertive');
    el.setAttribute('aria-atomic', 'true');
    setStyles(el, VISUALLY_HIDDEN);
    host.appendChild(el);
    region = el;
    return el;
  }

  function stopActive(): void {
    if (active === null) return;
    if (active.write !== null) clearTimeout(active.write);
    if (active.end !== null) clearTimeout(active.end);
    active = null;
  }

  return {
    name: 'aria-live',

    async init(): Promise<TtsCapabilities> {
      ensureRegion();
      return { available: hasDom(), vietnameseVoice: true, offlineVietnamese: true, requiresUserGesture: false };
    },

    unlock(): void {
      ensureRegion(); // trình đọc màn hình không cần mở khóa; chỉ bảo đảm vùng đã có trong DOM
    },

    speak(text, opts, hooks): void {
      const el = ensureRegion();
      if (el === null) {
        safeCall('onError', () => hooks.onError(new AppError('TTS_UNAVAILABLE', 'Không có DOM để đọc bằng trình đọc màn hình.')));
        return;
      }
      stopActive(); // câu mới thay câu cũ; hook của câu cũ không được gọi
      el.setAttribute('lang', opts.lang);
      el.textContent = ''; // xóa trước để câu giống hệt vẫn là một thay đổi
      const utterance: Utterance = { write: null, end: null };
      utterance.write = setTimeout(() => {
        utterance.write = null;
        el.textContent = text;
      }, REWRITE_DELAY_MS);
      utterance.end = setTimeout(() => {
        if (active !== utterance) return;
        active = null;
        safeCall('onEnd', hooks.onEnd);
      }, estimateSpeechMs(text, opts.rate));
      active = utterance;
      safeCall('onStart', hooks.onStart);
    },

    cancel(): void {
      stopActive(); // bỏ câu hiện tại, KHÔNG gọi onEnd (giống các engine khác)
      if (region !== null) region.textContent = '';
    },
  };
}