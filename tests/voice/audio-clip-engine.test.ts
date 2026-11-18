import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import manifestFile from '../../public/audio/manifest.json';
import { AppError } from '../../src/contracts';
import type { TtsHooks } from '../../src/contracts';
import { clearRecentLogs, setLogSink } from '../../src/utils/logger';
import { AUDIO_KEYS } from '../../src/voice/prompt-manager';
import { createAudioClipEngineWith, silentWavDataUri } from '../../src/voice/audio-clip-engine';
import type { AudioClipEngine, AudioFetch } from '../../src/voice/audio-clip-engine';

type PlayMode = 'ok' | 'locked' | 'aborted' | 'throw';

/** Phần tử audio giả: ghi lại src mỗi lần play; ended() và fail() mô phỏng sự kiện của trình duyệt. */
class FakeAudio {
  src = '';
  playbackRate = 1;
  playMode: PlayMode = 'ok';
  pauses = 0;
  readonly played: string[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  play(): Promise<void> {
    this.played.push(this.src);
    if (this.playMode === 'throw') throw new Error('play hỏng');
    if (this.playMode === 'locked') return Promise.reject(Object.assign(new Error('bị khóa'), { name: 'NotAllowedError' }));
    if (this.playMode === 'aborted') return Promise.reject(Object.assign(new Error('bị ngắt'), { name: 'AbortError' }));
    return Promise.resolve();
  }

  pause(): void {
    this.pauses += 1;
  }

  ended(): void {
    this.onended?.();
  }

  fail(): void {
    this.onerror?.();
  }
}

const FILES = Object.fromEntries(AUDIO_KEYS.map((k) => [k, `${k}.mp3`]));

interface FetchPlan {
  manifest?: { ok: boolean; body?: unknown; jsonError?: boolean } | 'throw';
  existing?: string[]; // tên file có thật
}

function fakeFetch(plan: FetchPlan): { fetchFn: AudioFetch; requests: string[] } {
  const requests: string[] = [];
  const fetchFn: AudioFetch = (url, init) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('audio/manifest.json')) {
      const m = plan.manifest ?? { ok: true, body: FILES };
      if (m === 'throw') return Promise.reject(new Error('mất mạng'));
      return Promise.resolve({ ok: m.ok, json: () => (m.jsonError ? Promise.reject(new Error('JSON hỏng')) : Promise.resolve(m.body)) });
    }
    const file = url.split('/').pop() ?? '';
    return Promise.resolve({ ok: (plan.existing ?? Object.values(FILES)).includes(file), json: () => Promise.resolve(null) });
  };
  return { fetchFn, requests };
}

function setup(plan: FetchPlan = {}, baseUrl = './') {
  const audio = new FakeAudio();
  const { fetchFn, requests } = fakeFetch(plan);
  let created = 0;
  const engine: AudioClipEngine = createAudioClipEngineWith({
    baseUrl,
    fetchFn,
    createAudio: () => {
      created += 1;
      return audio as unknown as HTMLAudioElement;
    },
  });
  return { engine, audio, requests, created: () => created };
}

function recorder() {
  const log: string[] = [];
  const errors: unknown[] = [];
  const hooks: TtsHooks = {
    onStart: () => void log.push('start'),
    onEnd: () => void log.push('end'),
    onError: (e) => {
      log.push('error');
      errors.push(e);
    },
  };
  return { hooks, log, errors };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const OPTS = (audioKey?: string) => ({ rate: 1.2, lang: 'vi-VN', ...(audioKey === undefined ? {} : { audioKey }) });

beforeEach(() => setLogSink(() => undefined));
afterEach(() => {
  setLogSink(null);
  clearRecentLogs();
});

describe('manifest.json', () => {
  it('khớp đúng chín khóa AUDIO_KEYS của prompt-manager, mỗi khóa trỏ tới <khóa>.mp3', () => {
    expect(Object.keys(manifestFile).sort()).toEqual([...AUDIO_KEYS].sort());
    expect(manifestFile).toEqual(FILES);
  });
});

describe('AudioClipEngine.init và canSpeak', () => {
  it('đủ file: available, requiresUserGesture true; kiểm tra từng file bằng HEAD từ thư mục gốc ./', async () => {
    const { engine, requests } = setup();
    expect(await engine.init()).toEqual({ available: true, vietnameseVoice: true, offlineVietnamese: true, requiresUserGesture: true });
    expect(requests[0]).toBe('GET ./audio/manifest.json');
    expect(requests).toContain('HEAD ./audio/welcome.mp3');
    expect(AUDIO_KEYS.every((k) => engine.canSpeak(k))).toBe(true);
  });

  it('thiếu một phần file: canSpeak chỉ đúng với khóa có file; khóa lạ và trước init đều false', async () => {
    const { engine } = setup({ existing: ['welcome.mp3', 'no-money.mp3'] });
    expect(engine.canSpeak('welcome')).toBe(false);
    expect((await engine.init()).available).toBe(true);
    expect(['welcome', 'no-money', 'blur', 'khong-co'].map((k) => engine.canSpeak(k))).toEqual([true, true, false, false]);
  });

  it.each<[string, FetchPlan]>([
    ['manifest 404', { manifest: { ok: false } }],
    ['mất kết nối khi đọc manifest', { manifest: 'throw' }],
    ['manifest không phải JSON', { manifest: { ok: true, jsonError: true } }],
    ['manifest là mảng', { manifest: { ok: true, body: ['welcome.mp3'] } }],
    ['manifest có nhưng không có file nào', { existing: [] }],
    ['mọi tên file đều không an toàn', { manifest: { ok: true, body: { a: '../a.mp3', b: '/b.mp3', c: 'x/c.mp3', d: '.d.mp3', e: 5 } } }],
  ])('%s: available false và không khóa nào dùng được', async (_label, plan) => {
    const { engine } = setup(plan);
    const caps = await engine.init();
    expect(caps).toEqual({ available: false, vietnameseVoice: false, offlineVietnamese: false, requiresUserGesture: false });
    expect(AUDIO_KEYS.some((k) => engine.canSpeak(k))).toBe(false);
  });

  it('bỏ qua tên file không an toàn, không bao giờ yêu cầu chúng', async () => {
    const { engine, requests } = setup({ manifest: { ok: true, body: { good: 'good.mp3', bad: '../bad.mp3', abs: '/abs.mp3' } }, existing: ['good.mp3'] });
    await engine.init();
    expect(requests.some((r) => r.includes('bad') || r.includes('abs'))).toBe(false);
    expect(engine.canSpeak('good')).toBe(true);
  });

  it.each<[string, string]>([
    ['./', './audio/manifest.json'],
    ['https://localhost/app', 'https://localhost/app/audio/manifest.json'],
    ['https://localhost/app/', 'https://localhost/app/audio/manifest.json'],
  ])('thư mục gốc %s', async (baseUrl, manifestUrl) => {
    const { engine, requests } = setup({}, baseUrl);
    await engine.init();
    expect(requests[0]).toBe(`GET ${manifestUrl}`);
  });
});

describe('AudioClipEngine.speak và cancel', () => {
  it('phát đúng file theo audioKey với tốc độ của opts; onStart rồi onEnd đúng một lần; một phần tử audio dùng lại', async () => {
    const { engine, audio, created } = setup();
    await engine.init();
    const rec = recorder();
    engine.speak('Xin chào!', OPTS('welcome'), rec.hooks);
    await settle();
    expect(audio.played).toEqual(['./audio/welcome.mp3']);
    expect(audio.playbackRate).toBe(1.2);
    expect(rec.log).toEqual(['start']);
    audio.ended();
    audio.ended();
    expect(rec.log).toEqual(['start', 'end']);
    engine.speak('x', OPTS('no-money'), recorder().hooks);
    expect(audio.played).toEqual(['./audio/welcome.mp3', './audio/no-money.mp3']);
    expect(created()).toBe(1);
  });

  it.each<[string, string | undefined]>([
    ['không có audioKey', undefined],
    ['khóa lạ', 'khong-co'],
    ['khóa có trong manifest nhưng thiếu file', 'blur'],
  ])('%s: onError TTS_UNAVAILABLE ngay, không đụng tới phần tử audio', async (_label, key) => {
    const { engine, audio, created } = setup({ existing: ['welcome.mp3'] });
    await engine.init();
    const rec = recorder();
    engine.speak('x', OPTS(key), rec.hooks);
    expect(rec.log).toEqual(['error']);
    expect((rec.errors[0] as AppError).code).toBe('TTS_UNAVAILABLE');
    expect(audio.played).toEqual([]);
    expect(created()).toBe(0);
  });

  it.each<[string, PlayMode]>([
    ['trình duyệt từ chối (chưa mở khóa)', 'locked'],
    ['play ném đồng bộ', 'throw'],
  ])('%s: onError, không onStart và không onEnd', async (_label, mode) => {
    const { engine, audio } = setup();
    await engine.init();
    audio.playMode = mode;
    const rec = recorder();
    engine.speak('x', OPTS('welcome'), rec.hooks);
    await settle();
    expect(rec.log).toEqual(['error']);
  });

  it('lỗi tải file (sự kiện error của audio): onError đúng một lần', async () => {
    const { engine, audio } = setup();
    await engine.init();
    const rec = recorder();
    engine.speak('x', OPTS('welcome'), rec.hooks);
    await settle();
    audio.fail();
    audio.fail();
    expect(rec.log).toEqual(['start', 'error']);
  });

  it('cancel: pause, bỏ qua ended muộn', async () => {
    const { engine, audio } = setup();
    await engine.init();
    const rec = recorder();
    engine.speak('x', OPTS('welcome'), rec.hooks);
    engine.cancel();
    audio.ended();
    await settle();
    expect(audio.pauses).toBe(1);
    expect(rec.log).toEqual([]);
  });

  it('clip mới thay clip cũ: pause clip cũ trước, ended muộn của clip cũ không tính', async () => {
    const { engine, audio } = setup();
    await engine.init();
    const first = recorder();
    const second = recorder();
    engine.speak('x', OPTS('welcome'), first.hooks);
    engine.speak('x', OPTS('blur'), second.hooks);
    expect(audio.pauses).toBe(1);
    await settle(); // play() của clip mới đã bắt đầu
    audio.ended();
    expect(first.log).toEqual([]);
    expect(second.log).toEqual(['start', 'end']);
  });

  it('tên engine là audio-clip', () => {
    expect(setup().engine.name).toBe('audio-clip');
  });
});

describe('AudioClipEngine.unlock', () => {
  it('phát một clip im lặng trên chính phần tử audio dùng lại, đúng một lần', async () => {
    const { engine, audio, created } = setup();
    await engine.init();
    engine.unlock();
    engine.unlock();
    expect(audio.played).toHaveLength(1);
    expect(audio.played[0]).toBe(silentWavDataUri());
    expect(created()).toBe(1);
    engine.speak('x', OPTS('welcome'), recorder().hooks);
    expect(created()).toBe(1);
  });

  it.each<[string, PlayMode, number]>([
    ['vẫn bị khóa (NotAllowedError): thử lại được lần chạm sau', 'locked', 2],
    ['bị clip thật ngắt (AbortError): không thử lại', 'aborted', 1],
  ])('%s', async (_label, mode, plays) => {
    const { engine, audio } = setup();
    await engine.init();
    audio.playMode = mode;
    engine.unlock();
    await settle();
    engine.unlock();
    expect(audio.played).toHaveLength(plays);
  });

  it('play ném lỗi đồng bộ: không ném ra ngoài, cho phép thử lại', async () => {
    const { engine, audio } = setup();
    audio.playMode = 'throw';
    expect(() => engine.unlock()).not.toThrow();
    engine.unlock();
    expect(audio.played).toHaveLength(2);
  });
});

describe('silentWavDataUri', () => {
  it('là WAV PCM hợp lệ: RIFF/WAVE, fmt 16 byte, data 2 byte, kích thước khớp', () => {
    const uri = silentWavDataUri();
    expect(uri.startsWith('data:audio/wav;base64,')).toBe(true);
    const bytes = Array.from(atob(uri.slice('data:audio/wav;base64,'.length)), (c) => c.charCodeAt(0));
    const text = (from: number, len: number): string => String.fromCharCode(...bytes.slice(from, from + len));
    const u32 = (at: number): number => (bytes[at] ?? 0) + ((bytes[at + 1] ?? 0) << 8) + ((bytes[at + 2] ?? 0) << 16);
    expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(u32(16)).toBe(16);
    expect(u32(40)).toBe(2);
    expect(u32(4)).toBe(bytes.length - 8);
    expect(bytes.length).toBe(44 + u32(40));
  });
});