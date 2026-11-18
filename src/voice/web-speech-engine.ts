import { AppError } from '../contracts';
import type { ITtsEngine, TtsCapabilities, TtsHooks } from '../contracts';
import { createLogger } from '../utils/logger';

const log = createLogger('web-speech');

/** Chờ sự kiện voiceschanged tối đa bấy nhiêu mili-giây (Chrome nạp danh sách giọng bất đồng bộ). */
export const VOICES_WAIT_MS = 2000;
/** Sau cancel() phải nghỉ bấy nhiêu mili-giây rồi mới speak, nếu không Chrome có thể nuốt câu mới. */
export const POST_CANCEL_DELAY_MS = 50;

export interface WebSpeechTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WebSpeechDeps {
  /** speechSynthesis của trình duyệt; null nếu không có. */
  synth: SpeechSynthesis | null;
  createUtterance: (text: string) => SpeechSynthesisUtterance;
  timers: WebSpeechTimers;
}

const UNAVAILABLE: TtsCapabilities = {
  available: false,
  vietnameseVoice: false,
  offlineVietnamese: false,
  requiresUserGesture: false,
};

function isVietnamese(lang: string): boolean {
  return lang.toLowerCase().replace('_', '-').startsWith('vi');
}

/** Chọn giọng Việt (lang bắt đầu bằng "vi", chấp nhận vi-VN lẫn vi_VN), ưu tiên giọng chạy cục bộ. */
export function pickVietnameseVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const vietnamese = voices.filter((v) => isVietnamese(v.lang));
  return vietnamese.find((v) => v.localService) ?? vietnamese[0] ?? null;
}

/**
 * Engine Web Speech với các thành phần tiêm vào (dùng cho test và cho createWebSpeechEngine).
 * KHÔNG BAO GIỜ đọc bằng giọng của ngôn ngữ khác: không có giọng Việt thì speak báo lỗi TTS_NO_VIETNAMESE_VOICE.
 */
export function createWebSpeechEngineWith(deps: WebSpeechDeps): ITtsEngine {
  const { synth, createUtterance, timers } = deps;
  let voice: SpeechSynthesisVoice | null = null;
  let unlocked = false;
  let counter = 0;
  // Giữ tham chiếu tới utterance đang đọc: trình duyệt có thể thu gom nó trước khi kịp phát onend.
  let current: { id: number; utterance: SpeechSynthesisUtterance } | null = null;
  let settling = false; // đang nghỉ sau cancel
  let settleTimer: unknown = null;
  let waiting: (() => void) | null = null; // lệnh speak chờ hết khoảng nghỉ

  function readVoices(): SpeechSynthesisVoice[] {
    try {
      return synth === null ? [] : synth.getVoices();
    } catch (e) {
      log.warn('getVoices lỗi:', e);
      return [];
    }
  }

  function capsFor(chosen: SpeechSynthesisVoice | null): TtsCapabilities {
    return {
      available: true,
      vietnameseVoice: chosen !== null,
      offlineVietnamese: chosen?.localService === true,
      requiresUserGesture: true,
      ...(chosen === null ? {} : { voiceName: chosen.name }),
    };
  }

  function init(): Promise<TtsCapabilities> {
    if (synth === null) return Promise.resolve({ ...UNAVAILABLE });
    const source = synth;
    return new Promise((resolve) => {
      if (readVoices().length > 0) {
        voice = pickVietnameseVoice(readVoices());
        resolve(capsFor(voice));
        return;
      }
      let done = false;
      let timer: unknown = null;
      const finish = (): void => {
        if (done) return;
        done = true;
        source.removeEventListener('voiceschanged', onChanged);
        if (timer !== null) timers.clearTimeout(timer);
        voice = pickVietnameseVoice(readVoices());
        resolve(capsFor(voice));
      };
      const onChanged = (): void => {
        if (readVoices().length > 0) finish();
      };
      source.addEventListener('voiceschanged', onChanged);
      timer = timers.setTimeout(finish, VOICES_WAIT_MS);
    });
  }

  /** Gọi trong lần chạm đầu tiên: phát một utterance rỗng để trình duyệt cho phép đọc về sau. */
  function unlock(): void {
    if (synth === null || unlocked) return;
    unlocked = true;
    try {
      synth.speak(createUtterance(''));
    } catch (e) {
      unlocked = false;
      log.warn('unlock lỗi:', e);
    }
  }

  function beginSettle(): void {
    settling = true;
    if (settleTimer !== null) timers.clearTimeout(settleTimer);
    settleTimer = timers.setTimeout(() => {
      settleTimer = null;
      settling = false;
      const run = waiting;
      waiting = null;
      run?.();
    }, POST_CANCEL_DELAY_MS);
  }

  function cancel(): void {
    current = null;
    waiting = null;
    if (synth === null) return;
    try {
      synth.cancel();
    } catch (e) {
      log.warn('synth.cancel lỗi:', e);
    }
    beginSettle();
  }

  function speak(text: string, opts: { rate: number; lang: string; audioKey?: string }, hooks: TtsHooks): void {
    if (synth === null) {
      hooks.onError(new AppError('TTS_UNAVAILABLE', 'Trình duyệt không có Web Speech'));
      return;
    }
    const chosen = voice ?? pickVietnameseVoice(readVoices());
    if (chosen === null) {
      hooks.onError(new AppError('TTS_NO_VIETNAMESE_VOICE', 'Không có giọng đọc tiếng Việt, không đọc bằng giọng khác'));
      return;
    }
    voice = chosen;
    if (current !== null) cancel(); // không để hai câu chồng nhau

    const utterance = createUtterance(text);
    utterance.voice = chosen;
    utterance.lang = opts.lang;
    utterance.rate = opts.rate;
    counter += 1;
    const id = counter;
    utterance.onstart = () => {
      if (current?.id === id) hooks.onStart();
    };
    utterance.onend = () => {
      if (current?.id !== id) return;
      current = null;
      hooks.onEnd();
    };
    utterance.onerror = (ev) => {
      if (current?.id !== id) return;
      current = null;
      hooks.onError(new AppError('TTS_UNAVAILABLE', 'Web Speech báo lỗi khi đọc', false, ev.error));
    };
    current = { id, utterance };

    const start = (): void => {
      if (current?.id !== id) return;
      try {
        if (synth.paused) synth.resume();
        synth.speak(utterance);
      } catch (e) {
        current = null;
        hooks.onError(new AppError('TTS_UNAVAILABLE', 'synth.speak ném lỗi', false, e));
      }
    };
    if (settling) waiting = start;
    else start();
  }

  return { name: 'web-speech', init, unlock, speak, cancel };
}

/** Engine Web Speech thật (dùng khi chạy trên trình duyệt lúc dev và làm dự phòng). */
export function createWebSpeechEngine(): ITtsEngine {
  return createWebSpeechEngineWith({
    synth: typeof speechSynthesis === 'undefined' ? null : speechSynthesis,
    createUtterance: (text) => new SpeechSynthesisUtterance(text),
    timers: {
      setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
    },
  });
}