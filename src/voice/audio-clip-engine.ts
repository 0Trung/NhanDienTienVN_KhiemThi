import { AppError } from '../contracts';
import type { ITtsEngine, TtsCapabilities, TtsHooks } from '../contracts';
import { createLogger } from '../utils/logger';

const log = createLogger('audio-clip');

/** Engine phát file mp3 ghi sẵn theo audioKey; canSpeak cho biết khóa nào thực sự có file. */
export interface AudioClipEngine extends ITtsEngine {
  canSpeak(audioKey: string): boolean;
}

/** Phần của fetch mà engine dùng (fetch thật thỏa mãn kiểu này). */
export type AudioFetch = (url: string, init?: { method: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface AudioClipDeps {
  /** Thư mục gốc của ứng dụng (Vite base), ví dụ "./". Manifest nằm ở <baseUrl>audio/manifest.json. */
  baseUrl: string;
  fetchFn: AudioFetch;
  createAudio: () => HTMLAudioElement;
}

const UNAVAILABLE: TtsCapabilities = {
  available: false,
  vietnameseVoice: false,
  offlineVietnamese: false,
  requiresUserGesture: false,
};

/** Tên file hợp lệ: không có dấu gạch chéo, không bắt đầu bằng dấu chấm (chặn đường dẫn lạ trong manifest). */
const SAFE_FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/** WAV im lặng 2 mẫu, dựng từ byte: dùng để "mở khóa" phần tử audio trong lần chạm đầu tiên. */
export function silentWavDataUri(): string {
  const bytes = [
    0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, // "RIFF", 38, "WAVE"
    0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, // "fmt ", 16, PCM, mono
    0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, // 8000 Hz, 8000 byte/s, 1, 8 bit
    0x64, 0x61, 0x74, 0x61, 0x02, 0x00, 0x00, 0x00, 0x80, 0x80, // "data", 2 byte im lặng
  ];
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

function parseManifest(data: unknown): Array<[string, string]> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
  return Object.entries(data).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && SAFE_FILE_NAME.test(entry[1]),
  );
}

/** Engine audio-clip với các thành phần tiêm vào (dùng cho test và cho createAudioClipEngine). */
export function createAudioClipEngineWith(deps: AudioClipDeps): AudioClipEngine {
  const base = deps.baseUrl.endsWith('/') ? deps.baseUrl : `${deps.baseUrl}/`;
  const clips = new Map<string, string>(); // khóa → URL của file đã xác nhận tồn tại
  let audio: HTMLAudioElement | null = null; // MỘT phần tử audio, tạo lười và dùng lại cho mọi câu
  let counter = 0;
  let current = 0; // id của clip đang phát; 0 = không có
  let unlocked = false;

  function getAudio(): HTMLAudioElement {
    audio ??= deps.createAudio();
    return audio;
  }

  async function init(): Promise<TtsCapabilities> {
    clips.clear();
    try {
      const res = await deps.fetchFn(`${base}audio/manifest.json`);
      if (res.ok) {
        const entries = parseManifest(await res.json());
        await Promise.all(
          entries.map(async ([key, file]) => {
            const url = `${base}audio/${file}`;
            try {
              if ((await deps.fetchFn(url, { method: 'HEAD' })).ok) clips.set(key, url);
            } catch (e) {
              log.warn(`Không kiểm tra được file ${file}:`, e);
            }
          }),
        );
      }
    } catch (e) {
      log.warn('Không đọc được manifest âm thanh ghi sẵn:', e);
    }
    if (clips.size === 0) return { ...UNAVAILABLE };
    // requiresUserGesture = true: giả định chính sách tự phát của WebView chưa được nới (nếu đã nới thì để false).
    return { available: true, vietnameseVoice: true, offlineVietnamese: true, requiresUserGesture: true };
  }

  /** Gọi trong lần chạm đầu tiên: phát một clip im lặng trên chính phần tử audio sẽ dùng về sau. */
  function unlock(): void {
    if (unlocked) return;
    unlocked = true;
    try {
      const el = getAudio();
      el.src = silentWavDataUri();
      const started: Promise<void> | undefined = el.play();
      started?.catch((e: unknown) => {
        if (e instanceof Error && e.name === 'NotAllowedError') unlocked = false; // vẫn bị khóa: thử lại lần chạm sau
      });
    } catch (e) {
      unlocked = false;
      log.warn('unlock lỗi:', e);
    }
  }

  function speak(_text: string, opts: { rate: number; lang: string; audioKey?: string }, hooks: TtsHooks): void {
    const url = opts.audioKey === undefined ? undefined : clips.get(opts.audioKey);
    if (url === undefined) {
      hooks.onError(new AppError('TTS_UNAVAILABLE', `Không có âm thanh ghi sẵn cho khóa ${String(opts.audioKey)}`));
      return;
    }
    const el = getAudio();
    if (current !== 0) el.pause(); // không để hai clip chồng nhau
    counter += 1;
    const id = counter;
    current = id;
    el.onended = () => {
      if (current !== id) return;
      current = 0;
      hooks.onEnd();
    };
    el.onerror = () => {
      if (current !== id) return;
      current = 0;
      hooks.onError(new AppError('TTS_UNAVAILABLE', 'Không phát được file âm thanh ghi sẵn'));
    };
    const fail = (e: unknown): void => {
      if (current !== id) return;
      current = 0;
      hooks.onError(new AppError('TTS_UNAVAILABLE', 'Trình duyệt từ chối phát âm thanh ghi sẵn', false, e));
    };
    try {
      el.src = url;
      el.playbackRate = opts.rate;
      const started: Promise<void> | undefined = el.play();
      if (started === undefined) hooks.onStart();
      else {
        started.then(() => {
          if (current === id) hooks.onStart();
        }, fail);
      }
    } catch (e) {
      fail(e);
    }
  }

  function cancel(): void {
    current = 0;
    audio?.pause();
  }

  return { name: 'audio-clip', init, unlock, speak, cancel, canSpeak: (audioKey) => clips.has(audioKey) };
}

/** Engine audio-clip thật: phát mp3 trong public/audio (đã nằm sẵn trong APK, chạy được khi không có mạng). */
export function createAudioClipEngine(o?: { baseUrl?: string }): AudioClipEngine {
  return createAudioClipEngineWith({
    baseUrl: o?.baseUrl ?? './',
    fetchFn: (url, init) => fetch(url, init),
    createAudio: () => new Audio(),
  });
}