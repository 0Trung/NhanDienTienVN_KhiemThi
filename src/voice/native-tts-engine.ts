import { DEFAULT_SETTINGS } from '../config/app-config';
import { AppError } from '../contracts';
import type { ITtsEngine, TtsCapabilities, TtsHooks } from '../contracts';
import { createLogger } from '../utils/logger';
import { getPlatform } from '../utils/platform';
import { createCapacitorTtsPort } from './native-tts-adapter';

const log = createLogger('native-tts');

const VIETNAMESE_LANG = DEFAULT_SETTINGS.voiceLanguage;

export interface NativeTtsVoice {
  lang: string;
  name?: string;
  /** true nếu giọng chạy cục bộ (không cần Internet); undefined nếu plugin không cho biết. */
  localService?: boolean;
}

/**
 * Cổng nhỏ che plugin TTS native. Mọi lỗi của plugin phải ra ngoài dưới dạng AppError TTS_UNAVAILABLE.
 * speak luôn dùng hàng đợi kiểu flush: câu mới thay câu đang đọc; promise hoàn tất khi đọc xong.
 */
export interface NativeTtsPort {
  isLanguageSupported(lang: string): Promise<boolean>;
  listVoices(): Promise<NativeTtsVoice[]>;
  speak(o: { text: string; lang: string; rate: number }): Promise<void>;
  stop(): Promise<void>;
}

export interface NativeTtsDeps {
  port: NativeTtsPort;
  isNative: () => boolean;
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

function toAppError(e: unknown): AppError {
  return e instanceof AppError ? e : new AppError('TTS_UNAVAILABLE', 'Engine đọc của điện thoại gặp lỗi', false, e);
}

/** Engine TTS native với cổng tiêm vào (dùng cho test và cho createNativeTtsEngine). */
export function createNativeTtsEngineWith(deps: NativeTtsDeps): ITtsEngine {
  const { port } = deps;
  let counter = 0;
  let current = 0; // id của câu đang chờ plugin; 0 = không có câu nào

  function stopQuietly(): void {
    try {
      port.stop().catch((e: unknown) => log.warn('port.stop lỗi:', e));
    } catch (e) {
      log.warn('port.stop ném lỗi:', e);
    }
  }

  async function init(): Promise<TtsCapabilities> {
    if (!deps.isNative()) return { ...UNAVAILABLE };
    try {
      const supported = await port.isLanguageSupported(VIETNAMESE_LANG);
      let viVoices: NativeTtsVoice[] = [];
      try {
        viVoices = (await port.listVoices()).filter((v) => isVietnamese(v.lang));
      } catch (e) {
        log.warn('Không liệt kê được giọng của máy:', e);
      }
      // KHÔNG CHẮC: nếu plugin không cho biết giọng nào chạy cục bộ thì coi giọng Việt là chạy ngoại tuyến (xem Giả định).
      const localKnown = viVoices.some((v) => typeof v.localService === 'boolean');
      const offlineVietnamese = supported && (localKnown ? viVoices.some((v) => v.localService === true) : true);
      const voiceName = (viVoices.find((v) => v.localService === true) ?? viVoices[0])?.name;
      return {
        available: true,
        vietnameseVoice: supported,
        offlineVietnamese,
        requiresUserGesture: false,
        ...(voiceName === undefined ? {} : { voiceName }),
      };
    } catch (e) {
      log.warn('Plugin TTS không dùng được:', toAppError(e));
      return { ...UNAVAILABLE };
    }
  }

  function speak(text: string, opts: { rate: number; lang: string; audioKey?: string }, hooks: TtsHooks): void {
    if (current !== 0) {
      current = 0; // câu cũ bị thay: kết quả muộn của nó sẽ bị bỏ qua
      stopQuietly();
    }
    counter += 1;
    const id = counter;
    current = id;
    hooks.onStart();
    let pending: Promise<void>;
    try {
      pending = port.speak({ text, lang: opts.lang, rate: opts.rate });
    } catch (e) {
      current = 0;
      hooks.onError(toAppError(e));
      return;
    }
    pending.then(
      () => {
        if (current !== id) return;
        current = 0;
        hooks.onEnd();
      },
      (e: unknown) => {
        if (current !== id) return;
        current = 0;
        hooks.onError(toAppError(e));
      },
    );
  }

  function cancel(): void {
    current = 0;
    stopQuietly();
  }

  return { name: 'native-tts', init, unlock: () => undefined, speak, cancel };
}

/** Engine TTS native thật: chỉ available trong APK Android. */
export function createNativeTtsEngine(): ITtsEngine {
  return createNativeTtsEngineWith({
    port: createCapacitorTtsPort(),
    isNative: () => getPlatform() === 'android-native',
  });
}