import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/contracts';
import type { ITtsEngine, TtsCapabilities, TtsHooks } from '../../src/contracts';
import { clearRecentLogs, setLogSink } from '../../src/utils/logger';
import {
  createWebSpeechEngineWith, pickVietnameseVoice, POST_CANCEL_DELAY_MS, VOICES_WAIT_MS,
} from '../../src/voice/web-speech-engine';

interface Handlers {
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
}

class FakeUtterance implements Handlers {
  voice: unknown = null;
  lang = '';
  rate = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;

  constructor(readonly text: string) {}
}

/** speechSynthesis giả: ghi lại mọi lời gọi; voiceschanged do test tự phát. */
class FakeSynth {
  voices: SpeechSynthesisVoice[] = [];
  paused = false;
  speakThrows = false;
  cancels = 0;
  resumes = 0;
  readonly spoken: FakeUtterance[] = [];
  private readonly listeners = new Set<() => void>();

  getVoices(): SpeechSynthesisVoice[] {
    return this.voices;
  }

  speak(u: FakeUtterance): void {
    if (this.speakThrows) throw new Error('synth.speak hỏng');
    this.spoken.push(u);
  }

  cancel(): void {
    this.cancels += 1;
  }

  resume(): void {
    this.resumes += 1;
    this.paused = false;
  }

  addEventListener(_type: string, listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: () => void): void {
    this.listeners.delete(listener);
  }

  emitVoicesChanged(): void {
    for (const listener of [...this.listeners]) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

const voice = (name: string, lang: string, localService: boolean): SpeechSynthesisVoice =>
  ({ name, lang, localService, default: false, voiceURI: name }) as SpeechSynthesisVoice;

function createScheduler() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { at: number; run: () => void }>();
  return {
    setTimeout(run: () => void, ms: number): unknown {
      const id = nextId++;
      tasks.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout(handle: unknown): void {
      tasks.delete(handle as number);
    },
    get pending(): number {
      return tasks.size;
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...tasks].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        tasks.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = target;
    },
  };
}

const VI_LOCAL = voice('vi-local', 'vi-VN', true);
const VI_NET = voice('vi-net', 'vi-VN', false);
const EN = voice('en', 'en-US', true);

function setup(voices: SpeechSynthesisVoice[] = [VI_LOCAL]) {
  const synth = new FakeSynth();
  synth.voices = voices;
  const sched = createScheduler();
  const engine: ITtsEngine = createWebSpeechEngineWith({
    synth: synth as unknown as SpeechSynthesis,
    createUtterance: (text) => new FakeUtterance(text) as unknown as SpeechSynthesisUtterance,
    timers: sched,
  });
  return { synth, sched, engine };
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

const OPTS = { rate: 0.8, lang: 'vi-VN' };

beforeEach(() => setLogSink(() => undefined));
afterEach(() => {
  setLogSink(null);
  clearRecentLogs();
});

describe('pickVietnameseVoice', () => {
  it.each<[string, SpeechSynthesisVoice[], string | null]>([
    ['danh sách rỗng', [], null],
    ['chỉ có tiếng Anh', [EN], null],
    ['ưu tiên giọng cục bộ đứng sau', [VI_NET, VI_LOCAL], 'vi-local'],
    ['giọng cục bộ đứng trước', [VI_LOCAL, VI_NET], 'vi-local'],
    ['vi_VN (gạch dưới)', [voice('a', 'vi_VN', false)], 'a'],
    ['mã chỉ có vi', [voice('b', 'vi', false)], 'b'],
    ['viết hoa', [voice('c', 'VI-vn', true)], 'c'],
    ['bỏ qua giọng ngôn ngữ khác dù cục bộ', [EN, VI_NET], 'vi-net'],
  ])('%s', (_label, voices, expected) => {
    expect(pickVietnameseVoice(voices)?.name ?? null).toBe(expected);
  });
});

describe('WebSpeechEngine.init', () => {
  it('có giọng sẵn: trả ngay, không chờ hẹn giờ; requiresUserGesture true', async () => {
    const { engine, sched } = setup([EN, VI_LOCAL]);
    expect(await engine.init()).toEqual({
      available: true, vietnameseVoice: true, offlineVietnamese: true, requiresUserGesture: true, voiceName: 'vi-local',
    });
    expect(sched.pending).toBe(0);
  });

  it('giọng Việt chỉ qua mạng: offlineVietnamese false', async () => {
    const { engine } = setup([VI_NET]);
    const caps = await engine.init();
    expect(caps.vietnameseVoice).toBe(true);
    expect(caps.offlineVietnamese).toBe(false);
  });

  it('voiceschanged đến trễ: chờ rồi chọn giọng, dọn listener và hẹn giờ', async () => {
    const { engine, sched, synth } = setup([]);
    const results: TtsCapabilities[] = [];
    void engine.init().then((c) => results.push(c));
    sched.advance(1500);
    await Promise.resolve();
    expect(results).toHaveLength(0);
    synth.voices = [EN, VI_LOCAL];
    synth.emitVoicesChanged();
    await Promise.resolve();
    expect(results).toHaveLength(1);
    expect(results[0]?.vietnameseVoice).toBe(true);
    expect(results[0]?.voiceName).toBe('vi-local');
    expect(synth.listenerCount).toBe(0);
    expect(sched.pending).toBe(0);
  });

  it('quá 2 giây không có voiceschanged: trả về không có giọng Việt, vẫn available', async () => {
    const { engine, sched, synth } = setup([]);
    const results: TtsCapabilities[] = [];
    void engine.init().then((c) => results.push(c));
    sched.advance(VOICES_WAIT_MS - 1);
    await Promise.resolve();
    expect(results).toHaveLength(0);
    sched.advance(1);
    await Promise.resolve();
    expect(results).toEqual([{ available: true, vietnameseVoice: false, offlineVietnamese: false, requiresUserGesture: true }]);
    expect(synth.listenerCount).toBe(0);
  });

  it('voiceschanged đến nhưng danh sách vẫn rỗng: chờ tiếp đến hết 2 giây', async () => {
    const { engine, sched, synth } = setup([]);
    let done = false;
    void engine.init().then(() => (done = true));
    synth.emitVoicesChanged();
    await Promise.resolve();
    expect(done).toBe(false);
    sched.advance(VOICES_WAIT_MS);
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('không có speechSynthesis: available false', async () => {
    const engine = createWebSpeechEngineWith({
      synth: null, createUtterance: (t) => new FakeUtterance(t) as unknown as SpeechSynthesisUtterance, timers: createScheduler(),
    });
    expect((await engine.init()).available).toBe(false);
  });
});

describe('WebSpeechEngine.speak', () => {
  it('đọc bằng giọng Việt đã chọn với lang và rate của opts; onStart và onEnd qua sự kiện của utterance', async () => {
    const { engine, synth } = setup([EN, VI_LOCAL]);
    await engine.init();
    const rec = recorder();
    engine.speak('Năm mươi nghìn đồng.', OPTS, rec.hooks);
    const u = synth.spoken[0];
    expect(u?.text).toBe('Năm mươi nghìn đồng.');
    expect(u?.voice).toBe(VI_LOCAL);
    expect([u?.lang, u?.rate]).toEqual(['vi-VN', 0.8]);
    u?.onstart?.();
    u?.onend?.();
    u?.onend?.(); // sự kiện lặp bị bỏ qua
    expect(rec.log).toEqual(['start', 'end']);
  });

  it('gọi resume trước khi đọc nếu đang paused, không thì thôi', async () => {
    const paused = setup();
    paused.synth.paused = true;
    paused.engine.speak('x', OPTS, recorder().hooks);
    expect(paused.synth.resumes).toBe(1);
    const normal = setup();
    normal.engine.speak('x', OPTS, recorder().hooks);
    expect(normal.synth.resumes).toBe(0);
  });

  it('lỗi của trình duyệt: onError với AppError TTS_UNAVAILABLE', () => {
    const { engine, synth } = setup();
    const rec = recorder();
    engine.speak('x', OPTS, rec.hooks);
    synth.spoken[0]?.onerror?.({ error: 'not-allowed' });
    expect(rec.log).toEqual(['error']);
    expect((rec.errors[0] as AppError).code).toBe('TTS_UNAVAILABLE');
  });

  it('synth.speak ném lỗi: onError, không ném ra ngoài', () => {
    const { engine, synth } = setup();
    synth.speakThrows = true;
    const rec = recorder();
    expect(() => engine.speak('x', OPTS, rec.hooks)).not.toThrow();
    expect(rec.log).toEqual(['error']);
  });

  it.each<[string, SpeechSynthesisVoice[]]>([
    ['không có giọng nào', []],
    ['chỉ có giọng ngôn ngữ khác', [EN, voice('fr', 'fr-FR', true)]],
  ])('%s: KHÔNG đọc bằng giọng khác, báo TTS_NO_VIETNAMESE_VOICE', async (_label, voices) => {
    const { engine, synth, sched } = setup(voices);
    const init = engine.init();
    sched.advance(VOICES_WAIT_MS);
    const caps = await init;
    expect(caps.vietnameseVoice).toBe(false);
    const rec = recorder();
    engine.speak('Năm mươi nghìn đồng.', OPTS, rec.hooks);
    sched.advance(1000);
    expect(synth.spoken).toHaveLength(0);
    expect(rec.log).toEqual(['error']);
    expect((rec.errors[0] as AppError).code).toBe('TTS_NO_VIETNAMESE_VOICE');
  });

  it('chưa gọi init nhưng giọng đã nạp xong: tự chọn giọng khi đọc', () => {
    const { engine, synth } = setup([EN, VI_NET]);
    engine.speak('x', OPTS, recorder().hooks);
    expect(synth.spoken[0]?.voice).toBe(VI_NET);
  });

  it('không có speechSynthesis: onError TTS_UNAVAILABLE', () => {
    const engine = createWebSpeechEngineWith({
      synth: null, createUtterance: (t) => new FakeUtterance(t) as unknown as SpeechSynthesisUtterance, timers: createScheduler(),
    });
    const rec = recorder();
    engine.speak('x', OPTS, rec.hooks);
    expect((rec.errors[0] as AppError).code).toBe('TTS_UNAVAILABLE');
  });
});

describe('WebSpeechEngine.cancel', () => {
  it('sau cancel đợi 50 ms rồi mới speak', () => {
    const { engine, synth, sched } = setup();
    engine.cancel();
    engine.speak('x', OPTS, recorder().hooks);
    expect(synth.cancels).toBe(1);
    expect(synth.spoken).toHaveLength(0);
    sched.advance(POST_CANCEL_DELAY_MS - 1);
    expect(synth.spoken).toHaveLength(0);
    sched.advance(1);
    expect(synth.spoken).toHaveLength(1);
  });

  it('hết khoảng nghỉ thì speak chạy ngay, không chờ nữa', () => {
    const { engine, synth, sched } = setup();
    engine.cancel();
    sched.advance(POST_CANCEL_DELAY_MS);
    engine.speak('x', OPTS, recorder().hooks);
    expect(synth.spoken).toHaveLength(1);
  });

  it('cancel trong lúc câu đang chờ khoảng nghỉ thì bỏ câu đó', () => {
    const { engine, synth, sched } = setup();
    engine.cancel();
    engine.speak('x', OPTS, recorder().hooks);
    engine.cancel();
    sched.advance(1000);
    expect(synth.spoken).toHaveLength(0);
    expect(synth.cancels).toBe(2);
  });

  it('sự kiện muộn của câu đã hủy bị bỏ qua', () => {
    const { engine, synth } = setup();
    const rec = recorder();
    engine.speak('x', OPTS, rec.hooks);
    const u = synth.spoken[0];
    engine.cancel();
    u?.onend?.();
    u?.onerror?.({ error: 'canceled' });
    u?.onstart?.();
    expect(rec.log).toEqual([]);
  });

  it('speak khi câu trước còn đang đọc: hủy câu cũ, đọc câu mới sau 50 ms, không chồng tiếng', () => {
    const { engine, synth, sched } = setup();
    const first = recorder();
    const second = recorder();
    engine.speak('một', OPTS, first.hooks);
    engine.speak('hai', OPTS, second.hooks);
    expect(synth.cancels).toBe(1);
    expect(synth.spoken.map((u) => u.text)).toEqual(['một']);
    sched.advance(POST_CANCEL_DELAY_MS);
    expect(synth.spoken.map((u) => u.text)).toEqual(['một', 'hai']);
    synth.spoken[0]?.onend?.(); // sự kiện của câu cũ
    expect(first.log).toEqual([]);
    synth.spoken[1]?.onend?.();
    expect(second.log).toEqual(['end']);
  });
});

describe('WebSpeechEngine.unlock', () => {
  it('phát đúng một utterance rỗng trong lần chạm đầu tiên', () => {
    const { engine, synth } = setup();
    engine.unlock();
    engine.unlock();
    expect(synth.spoken.map((u) => u.text)).toEqual(['']);
  });

  it('synth.speak ném lỗi thì không ném ra ngoài và cho phép thử lại', () => {
    const { engine, synth } = setup();
    synth.speakThrows = true;
    expect(() => engine.unlock()).not.toThrow();
    synth.speakThrows = false;
    engine.unlock();
    expect(synth.spoken).toHaveLength(1);
  });

  it('tên engine là web-speech', () => {
    expect(setup().engine.name).toBe('web-speech');
  });
});