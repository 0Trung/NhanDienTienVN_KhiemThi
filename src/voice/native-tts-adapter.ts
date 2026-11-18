// FILE ADAPTER DUY NHẤT gọi plugin @capacitor-community/text-to-speech. Mọi nơi khác đi qua NativeTtsPort.
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { AppError } from '../contracts';
import type { NativeTtsPort, NativeTtsVoice } from './native-tts-engine';

/** Phần của plugin mà adapter dùng. Tên hàm và tham số cần xác minh với phiên bản cài thật (xem Giả định). */
export interface TextToSpeechPluginLike {
  speak(options: { text: string; lang: string; rate: number; queueStrategy: number }): Promise<void>;
  stop(): Promise<void>;
  isLanguageSupported(options: { lang: string }): Promise<{ supported: boolean }>;
  getSupportedVoices(): Promise<{ voices: Array<{ lang: string; name?: string; localService?: boolean }> }>;
}

/** queueStrategy trên Android: 0 = Flush (câu mới thay câu đang đọc), 1 = Add (xếp hàng). */
export const QUEUE_FLUSH = 0;

/** Bọc mọi lời gọi plugin: lỗi đồng bộ hay bất đồng bộ đều thành AppError TTS_UNAVAILABLE. */
async function guard<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw new AppError('TTS_UNAVAILABLE', `Plugin TTS lỗi khi ${what}`, false, e);
  }
}

export function createCapacitorTtsPort(plugin: TextToSpeechPluginLike = TextToSpeech): NativeTtsPort {
  return {
    isLanguageSupported: (lang) =>
      guard('kiểm tra ngôn ngữ', async () => (await plugin.isLanguageSupported({ lang })).supported === true),
    listVoices: () =>
      guard('liệt kê giọng', async (): Promise<NativeTtsVoice[]> => {
        const { voices } = await plugin.getSupportedVoices();
        if (!Array.isArray(voices)) throw new TypeError('getSupportedVoices không trả về danh sách giọng');
        return voices.map((v) => ({ lang: v.lang, name: v.name, localService: v.localService }));
      }),
    speak: ({ text, lang, rate }) => guard('đọc', () => plugin.speak({ text, lang, rate, queueStrategy: QUEUE_FLUSH })),
    stop: () => guard('dừng đọc', () => plugin.stop()),
  };
}