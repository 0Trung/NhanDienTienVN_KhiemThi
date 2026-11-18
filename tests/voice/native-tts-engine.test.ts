import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/contracts';
import type { TtsCapabilities, TtsHooks } from '../../src/contracts';
import { clearRecentLogs, setLogSink } from '../../src/utils/logger';
import { createCapacitorTtsPort, QUEUE_FLUSH } from '../../src/voice/native-tts-adapter';
import type { TextToSpeechPluginLike } from '../../src/voice/native-tts-adapter';
import { createNativeTtsEngineWith } from '../../src/voice/native-tts-engine';
import type { NativeTtsPort, NativeTtsVoice } from '../../src/voice/native-tts-engine';

type SpeakMode = 'pending' | 'reject' | 'throw';

/** Cổng TTS giả: speak mặc định treo cho đến khi test gọi finish hoặc fail. */
class FakePort implements NativeTtsPort {
  supported = true;
  voices: NativeTtsVoice[] | Error = [];
  supportError: Error | null = null;
  speakMode: SpeakMode = 'pending';
  stopMode: 'ok' | 'reject' | 'throw' = 'ok';
  readonly calls: string[] = [];
  readonly spoken: Array<{ text: string; lang: string; rate: number }> = [];
  stops = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];

  isLanguageSupported(lang: string): Promise<boolean> {
    this.calls.push(`isLanguageSupported:${lang}`);
    return this.supportError === null ? Promise.resolve(this.supported) : Promise.reject(this.supportError);
  }

  listVoices(): Promise<NativeTtsVoice[]> {
    this.calls.push('listVoices');
    return this.voices instanceof Error ? Promise.reject(this.voices) : Promise.resolve(this.voices);
  }

  speak(o: { text: string; lang: string; rate: number }): Promise<void> {
    this.spoken.push(o);
    if (this.speakMode === 'throw') throw new Error('plugin ném đồng bộ');
    if (this.speakMode === 'reject') return Promise.reject(new Error('plugin từ chối'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  stop(): Promise<void> {
    this.stops += 1;
    if (this.stopMode === 'throw') throw new Error('stop ném đồng bộ');
    return this.stopMode === 'reject' ? Promise.reject(new Error('stop lỗi')) : Promise.resolve();
  }

  finish(index = this.waiters.length - 1): void {
    this.waiters[index]?.resolve();
  }
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

const OPTS = { rate: 1.2, lang: 'vi-VN' };
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const engineWith = (port: FakePort, isNative = true) => createNativeTtsEngineWith({ port, isNative: () => isNative });

beforeEach(() => setLogSink(() => undefined));
afterEach(() => {
  setLogSink(null);
  clearRecentLogs();
});

describe('NativeTtsEngine.init', () => {
  it('ngoài APK Android: available false và không gọi plugin', async () => {
    const port = new FakePort();
    const caps = await engineWith(port, false).init();
    expect(caps).toEqual({ available: false, vietnameseVoice: false, offlineVietnamese: false, requiresUserGesture: false });
    expect(port.calls).toEqual([]);
  });

  it.each<[string, boolean, NativeTtsVoice[] | Error, Partial<TtsCapabilities>]>([
    ['giọng Việt chạy cục bộ', true, [{ lang: 'en-US', name: 'en', localService: true }, { lang: 'vi-VN', name: 'vi-local', localService: true }],
      { vietnameseVoice: true, offlineVietnamese: true, voiceName: 'vi-local' }],
    ['giọng Việt chỉ qua mạng', true, [{ lang: 'vi-VN', name: 'vi-net', localService: false }],
      { vietnameseVoice: true, offlineVietnamese: false, voiceName: 'vi-net' }],
    ['ưu tiên giọng cục bộ dù đứng sau', true, [{ lang: 'vi-VN', name: 'vi-net', localService: false }, { lang: 'vi_VN', name: 'vi-local', localService: true }],
      { vietnameseVoice: true, offlineVietnamese: true, voiceName: 'vi-local' }],
    ['plugin không cho biết giọng nào cục bộ: coi là ngoại tuyến (không chắc)', true, [{ lang: 'vi-VN', name: 'vi' }],
      { vietnameseVoice: true, offlineVietnamese: true, voiceName: 'vi' }],
    ['danh sách giọng rỗng: coi là ngoại tuyến (không chắc)', true, [], { vietnameseVoice: true, offlineVietnamese: true }],
    ['không liệt kê được giọng: coi là ngoại tuyến (không chắc)', true, new Error('không liệt kê được'),
      { vietnameseVoice: true, offlineVietnamese: true }],
    ['không có giọng Việt', false, [{ lang: 'en-US', name: 'en', localService: true }],
      { vietnameseVoice: false, offlineVietnamese: false }],
  ])('%s', async (_label, supported, voices, expected) => {
    const port = new FakePort();
    port.supported = supported;
    port.voices = voices;
    const caps = await engineWith(port).init();
    expect(caps).toEqual({ available: true, requiresUserGesture: false, ...expected });
    expect(port.calls[0]).toBe('isLanguageSupported:vi-VN');
  });

  it('lỗi plugin khi kiểm tra ngôn ngữ: available false, không ném lỗi', async () => {
    const port = new FakePort();
    port.supportError = new AppError('TTS_UNAVAILABLE', 'plugin hỏng');
    expect((await engineWith(port).init()).available).toBe(false);
  });
});

describe('NativeTtsEngine.speak và cancel', () => {
  it('đọc qua port.speak với text, lang, rate; onStart rồi onEnd đúng một lần', async () => {
    const port = new FakePort();
    const rec = recorder();
    engineWith(port).speak('Năm mươi nghìn đồng.', OPTS, rec.hooks);
    expect(port.spoken).toEqual([{ text: 'Năm mươi nghìn đồng.', lang: 'vi-VN', rate: 1.2 }]);
    expect(rec.log).toEqual(['start']);
    port.finish();
    await settle();
    expect(rec.log).toEqual(['start', 'end']);
  });

  it.each<[string, SpeakMode]>([
    ['plugin từ chối', 'reject'],
    ['plugin ném đồng bộ', 'throw'],
  ])('%s: onError với AppError TTS_UNAVAILABLE, không onEnd', async (_label, mode) => {
    const port = new FakePort();
    port.speakMode = mode;
    const rec = recorder();
    engineWith(port).speak('x', OPTS, rec.hooks);
    await settle();
    expect(rec.log).toEqual(['start', 'error']);
    expect(rec.errors[0]).toBeInstanceOf(AppError);
    expect((rec.errors[0] as AppError).code).toBe('TTS_UNAVAILABLE');
  });

  it('giữ nguyên AppError mà adapter đã ném', async () => {
    const port = new FakePort();
    port.speak = () => Promise.reject(new AppError('TTS_NO_VIETNAMESE_VOICE', 'thiếu giọng'));
    const rec = recorder();
    engineWith(port).speak('x', OPTS, rec.hooks);
    await settle();
    expect((rec.errors[0] as AppError).code).toBe('TTS_NO_VIETNAMESE_VOICE');
  });

  it('cancel gọi port.stop và bỏ qua kết quả muộn của câu đã hủy', async () => {
    const port = new FakePort();
    const engine = engineWith(port);
    const rec = recorder();
    engine.speak('x', OPTS, rec.hooks);
    engine.cancel();
    port.finish();
    await settle();
    expect(port.stops).toBe(1);
    expect(rec.log).toEqual(['start']);
  });

  it('câu mới thay câu cũ: stop được gọi, kết quả muộn của câu cũ bị bỏ qua', async () => {
    const port = new FakePort();
    const engine = engineWith(port);
    const first = recorder();
    const second = recorder();
    engine.speak('một', OPTS, first.hooks);
    engine.speak('hai', OPTS, second.hooks);
    port.finish(0);
    await settle();
    expect(first.log).toEqual(['start']);
    expect(second.log).toEqual(['start']);
    port.finish(1);
    await settle();
    expect(second.log).toEqual(['start', 'end']);
    expect(port.stops).toBe(1);
  });

  it.each<['ok' | 'reject' | 'throw']>([['reject'], ['throw']])('port.stop %s không làm hỏng engine', async (mode) => {
    const port = new FakePort();
    port.stopMode = mode;
    const engine = engineWith(port);
    engine.speak('x', OPTS, recorder().hooks);
    expect(() => engine.cancel()).not.toThrow();
    await settle();
  });

  it('tên engine là native-tts; unlock không làm gì', () => {
    const engine = engineWith(new FakePort());
    expect(engine.name).toBe('native-tts');
    expect(() => engine.unlock()).not.toThrow();
  });
});

describe('createCapacitorTtsPort (adapter duy nhất gọi plugin)', () => {
  function plugin(overrides: Partial<TextToSpeechPluginLike> = {}): TextToSpeechPluginLike & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      speak: (o) => {
        calls.push(o);
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
      isLanguageSupported: (o) => {
        calls.push(o);
        return Promise.resolve({ supported: o.lang === 'vi-VN' });
      },
      getSupportedVoices: () => Promise.resolve({ voices: [{ lang: 'vi-VN', name: 'vi', localService: true, extra: 1 } as NativeTtsVoice] }),
      ...overrides,
    };
  }

  it('speak dùng hàng đợi flush và truyền đúng text, lang, rate', async () => {
    const p = plugin();
    await createCapacitorTtsPort(p).speak({ text: 'xin chào', lang: 'vi-VN', rate: 0.8 });
    expect(QUEUE_FLUSH).toBe(0);
    expect(p.calls).toEqual([{ text: 'xin chào', lang: 'vi-VN', rate: 0.8, queueStrategy: QUEUE_FLUSH }]);
  });

  it('isLanguageSupported và listVoices bóc kết quả của plugin', async () => {
    const port = createCapacitorTtsPort(plugin());
    expect(await port.isLanguageSupported('vi-VN')).toBe(true);
    expect(await port.isLanguageSupported('xx-XX')).toBe(false);
    expect(await port.listVoices()).toEqual([{ lang: 'vi-VN', name: 'vi', localService: true }]);
  });

  it('danh sách giọng sai dạng thì ném AppError TTS_UNAVAILABLE', async () => {
    const port = createCapacitorTtsPort(plugin({ getSupportedVoices: () => Promise.resolve({ voices: null as never }) }));
    const error = await port.listVoices().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
  });

  it.each<[string, 'reject' | 'throw']>([
    ['isLanguageSupported', 'reject'], ['isLanguageSupported', 'throw'], ['listVoices', 'reject'], ['listVoices', 'throw'],
    ['speak', 'reject'], ['speak', 'throw'], ['stop', 'reject'], ['stop', 'throw'],
  ])('%s: plugin %s → AppError TTS_UNAVAILABLE', async (method, mode) => {
    const fail = (): Promise<never> => (mode === 'reject' ? Promise.reject(new Error('hỏng')) : ((): never => { throw new Error('hỏng'); })());
    const port = createCapacitorTtsPort({
      speak: fail, stop: fail, isLanguageSupported: fail, getSupportedVoices: fail,
    });
    const calls: Record<string, () => Promise<unknown>> = {
      isLanguageSupported: () => port.isLanguageSupported('vi-VN'),
      listVoices: () => port.listVoices(),
      speak: () => port.speak({ text: 'x', lang: 'vi-VN', rate: 1 }),
      stop: () => port.stop(),
    };
    const error = await (calls[method] as () => Promise<unknown>)().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('TTS_UNAVAILABLE');
  });
});