import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_SETTINGS } from '../../src/config/app-config';
import type {
  AppConfig, Denomination, GuidanceCode, HapticEvent, IHaptics, ITtsEngine, RecognitionResult, Settings,
  SpeechIntent, TtsCapabilities, TtsHooks, UtteranceEvent,
} from '../../src/contracts';
import { clearRecentLogs, setLogSink } from '../../src/utils/logger';
import { mulberry32 } from '../../src/utils/math';
import { createFakeClock } from '../../src/utils/time';
import { createSpeechManagerWithTimers, splitIntoUtterances, utteranceTimeoutMs } from '../../src/voice/speech-manager';
import { FakeHaptics, FakeTtsEngine } from '../fakes';

/** Đồng hồ giả (createFakeClock của P00) kèm hẹn giờ: advance chạy các hẹn giờ đến hạn theo đúng thứ tự. */
function createScheduler() {
  const clock = createFakeClock(1000);
  let nextId = 1;
  const tasks = new Map<number, { at: number; run: () => void }>();
  return {
    now: clock.now,
    setTimeout(run: () => void, ms: number): unknown {
      const id = nextId++;
      tasks.set(id, { at: clock.now() + ms, run });
      return id;
    },
    clearTimeout(handle: unknown): void {
      tasks.delete(handle as number);
    },
    get pending(): number {
      return tasks.size;
    },
    advance(ms: number): void {
      const target = clock.now() + ms;
      for (;;) {
        const due = [...tasks].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        tasks.delete(due[0]);
        clock.advance(Math.max(0, due[1].at - clock.now()));
        due[1].run();
      }
      clock.advance(target - clock.now());
    },
  };
}

interface SetupOptions {
  engines?: FakeTtsEngine[];
  settings?: Partial<Settings>;
  config?: Partial<AppConfig['speech']>;
  haptics?: IHaptics;
}

async function setup(o: SetupOptions = {}) {
  const sched = createScheduler();
  const engines = o.engines ?? [new FakeTtsEngine()];
  const engine = engines[0] ?? new FakeTtsEngine();
  const fakeHaptics = new FakeHaptics();
  const settings: Settings = { ...DEFAULT_SETTINGS, ...o.settings };
  const config: AppConfig['speech'] = { ...DEFAULT_CONFIG.speech, ...o.config };
  const speech = createSpeechManagerWithTimers(
    { engines, haptics: o.haptics ?? fakeHaptics, getSettings: () => settings, config, now: sched.now },
    sched,
  );
  const events: UtteranceEvent[] = [];
  speech.onUtterance((e) => events.push(e));
  const caps = await speech.init();
  return { speech, engine, engines, haptics: fakeHaptics, sched, settings, config, events, caps };
}
type Env = Awaited<ReturnType<typeof setup>>;

const ev = (phase: UtteranceEvent['phase'], kind: UtteranceEvent['kind']): UtteranceEvent => ({ phase, kind });
const GUIDE = (code: GuidanceCode): SpeechIntent => ({ kind: 'GUIDANCE', code });

function makeResult(denominations: Denomination[], overrides: Partial<RecognitionResult> = {}): RecognitionResult {
  const total = denominations.reduce((sum, d) => sum + d, 0);
  return {
    status: denominations.length === 1 ? 'CONFIDENT_SINGLE' : 'CONFIDENT_MULTI',
    count: denominations.length, denominations, total, formattedTotal: `${total} đồng`, timestamp: 0, ...overrides,
  };
}
const RESULT = (...ds: Denomination[]): SpeechIntent => ({ kind: 'RESULT', result: makeResult(ds) });

/** Kết thúc câu đang đọc rồi chờ khoảng lặng, lặp đến khi hết hàng đợi. */
function drain(env: Env): void {
  for (let i = 0; i < 60; i += 1) {
    env.engine.finishCurrent();
    env.sched.advance(env.config.minGapMs);
    if (!env.speech.isSpeaking && env.sched.pending === 0) return;
  }
  throw new Error('drain: hàng đợi không cạn');
}

/** Engine cho phép gọi hook muộn sau khi bị hủy. */
class LateEngine extends FakeTtsEngine {
  readonly hooks: TtsHooks[] = [];

  speak(text: string, opts: { rate: number; lang: string; audioKey?: string }, hooks: TtsHooks): void {
    this.hooks.push(hooks);
    super.speak(text, opts, hooks);
  }
}

/** Engine ném lỗi ở lần speak đầu tiên. */
class ThrowOnceEngine extends FakeTtsEngine {
  private armed = true;

  speak(text: string, opts: { rate: number; lang: string; audioKey?: string }, hooks: TtsHooks): void {
    if (this.armed) {
      this.armed = false;
      throw new Error('engine hỏng');
    }
    super.speak(text, opts, hooks);
  }
}

const engineOf = (name: ITtsEngine['name'], capabilities?: Partial<TtsCapabilities>, initError?: unknown): FakeTtsEngine =>
  new FakeTtsEngine({ name, capabilities, initError });

beforeEach(() => setLogSink(() => undefined));
afterEach(() => {
  setLogSink(null);
  clearRecentLogs();
});

describe('chọn engine khi init', () => {
  it.each<[string, () => FakeTtsEngine[], Settings['speechOutput'], number]>([
    ['native trước web khi cả hai có giọng Việt', () => [engineOf('native-tts'), engineOf('web-speech')], 'APP_TTS', 0],
    ['bỏ qua engine không có giọng Việt', () => [engineOf('native-tts', { vietnameseVoice: false }), engineOf('web-speech')], 'APP_TTS', 1],
    ['bỏ qua engine không available', () => [engineOf('native-tts', { available: false }), engineOf('web-speech')], 'APP_TTS', 1],
    ['bỏ qua engine init lỗi', () => [engineOf('native-tts', undefined, new Error('init hỏng')), engineOf('web-speech')], 'APP_TTS', 1],
    ['SCREEN_READER chọn aria-live', () => [engineOf('native-tts'), engineOf('web-speech'), engineOf('aria-live')], 'SCREEN_READER', 2],
    ['SCREEN_READER không có aria-live thì chọn theo thứ tự', () => [engineOf('native-tts'), engineOf('web-speech')], 'SCREEN_READER', 0],
    ['APP_TTS không chọn aria-live đứng sau native', () => [engineOf('native-tts'), engineOf('aria-live')], 'APP_TTS', 0],
    ['không engine nào có giọng Việt: audio-clip', () => [engineOf('native-tts', { vietnameseVoice: false }), engineOf('audio-clip')], 'APP_TTS', 1],
    [
      'không giọng Việt, không audio-clip: engine dùng được đầu tiên',
      () => [engineOf('native-tts', { vietnameseVoice: false }), engineOf('web-speech', { vietnameseVoice: false })],
      'APP_TTS',
      0,
    ],
    ['không engine nào dùng được', () => [engineOf('native-tts', { available: false })], 'APP_TTS', -1],
  ])('%s', async (_label, make, speechOutput, chosen) => {
    const engines = make();
    const env = await setup({ engines, settings: { speechOutput } });
    env.speech.say({ kind: 'WELCOME' });
    expect(engines.map((e) => e.spoken.length)).toEqual(engines.map((_e, i) => (i === chosen ? 1 : 0)));
  });

  it('init trả năng lực của engine ĐÃ CHỌN, kể cả requiresUserGesture', async () => {
    const web = engineOf('web-speech', { requiresUserGesture: true, voiceName: 'vi-VN-test' });
    const env = await setup({ engines: [engineOf('native-tts', { available: false }), web] });
    expect(env.caps).toEqual({
      available: true, vietnameseVoice: true, offlineVietnamese: true, requiresUserGesture: true, voiceName: 'vi-VN-test',
    });
  });

  it('không có giọng Việt: báo vietnameseVoice false; không engine nào: available false', async () => {
    const noVoice = await setup({ engines: [engineOf('web-speech', { vietnameseVoice: false })] });
    expect(noVoice.caps.available).toBe(true);
    expect(noVoice.caps.vietnameseVoice).toBe(false);
    const none = await setup({ engines: [engineOf('native-tts', { available: false })] });
    expect(none.caps.available).toBe(false);
  });

  it('init lại sau khi đổi speechOutput thì chọn lại engine', async () => {
    const engines = [engineOf('native-tts'), engineOf('aria-live')];
    const env = await setup({ engines });
    env.settings.speechOutput = 'SCREEN_READER';
    await env.speech.init();
    env.speech.say({ kind: 'WELCOME' });
    expect(engines.map((e) => e.spoken.length)).toEqual([0, 1]);
  });

  it('audio-clip: chỉ đọc câu cố định, nguyên câu một lần (không cắt) kèm audioKey; câu khác chỉ rung', async () => {
    const clip = engineOf('audio-clip');
    const env = await setup({ engines: [engineOf('native-tts', { vietnameseVoice: false }), clip] });
    env.speech.say(GUIDE('NO_MONEY'));
    drain(env);
    env.speech.say(RESULT(50000));
    drain(env);
    expect(clip.spoken).toEqual([
      { text: 'Chưa nhận diện được tiền. Hãy đưa tiền đến trước camera.', rate: 1, lang: 'vi-VN', audioKey: 'no-money' },
    ]);
    expect(env.haptics.events).toEqual(['SUCCESS']);
  });

  it('engine khác audio-clip không nhận audioKey; say trước init chỉ rung', async () => {
    const env = await setup();
    env.speech.say({ kind: 'WELCOME' });
    expect(env.engine.spoken[0]?.audioKey).toBeUndefined();
    const fresh = createSpeechManagerWithTimers(
      { engines: [new FakeTtsEngine()], haptics: env.haptics, getSettings: () => env.settings, config: env.config },
      createScheduler(),
    );
    env.haptics.clear();
    fresh.say(RESULT(50000));
    expect(fresh.isSpeaking).toBe(false);
    expect(env.haptics.events).toEqual(['SUCCESS']);
  });
});

describe('hàng đợi ưu tiên', () => {
  const WELCOME = ['Xin chào! Hãy đưa tiền đến trước camera.'];
  const ACK = ['Đã bật rung.'];
  const FAR = ['Hãy đưa tiền lại gần camera hơn.'];
  const HOLD = ['Hãy giữ tiền yên trước camera.'];
  const R50 = ['Năm mươi nghìn đồng.'];
  const R100 = ['Một trăm nghìn đồng.'];
  const ERR = ['Không mở được camera.', 'Hãy đóng ứng dụng rồi mở lại.'];
  const ERROR: SpeechIntent = { kind: 'ERROR', code: 'CAMERA_FAILED' };

  it.each<[string, SpeechIntent, SpeechIntent, string[], number]>([
    ['GUIDANCE ngắt WELCOME', { kind: 'WELCOME' }, GUIDE('TOO_FAR'), [...WELCOME, ...FAR], 1],
    ['GUIDANCE ngắt SETTING_ACK', { kind: 'SETTING_ACK', what: 'VIBRATION_ON' }, GUIDE('TOO_FAR'), [...ACK, ...FAR], 1],
    ['RESULT ngắt GUIDANCE', GUIDE('TOO_FAR'), RESULT(50000), [...FAR, ...R50], 1],
    ['ERROR ngắt GUIDANCE', GUIDE('TOO_FAR'), ERROR, [...FAR, ...ERR], 1],
    ['ERROR ngắt RESULT', RESULT(50000), ERROR, [...R50, ...ERR], 1],
    ['RESULT không ngắt ERROR, chờ', ERROR, RESULT(50000), [...ERR, ...R50], 0],
    ['GUIDANCE không ngắt ERROR, chờ', ERROR, GUIDE('TOO_FAR'), [...ERR, ...FAR], 0],
    ['RESULT cùng mức xếp hàng sau RESULT', RESULT(50000), RESULT(100000), [...R50, ...R100], 0],
    ['GUIDANCE cùng mức xếp hàng sau GUIDANCE', GUIDE('TOO_FAR'), GUIDE('HOLD_STEADY'), [...FAR, ...HOLD], 0],
    ['GUIDANCE KHÔNG ngắt RESULT: bị bỏ', RESULT(50000), GUIDE('TOO_FAR'), R50, 0],
  ])('%s', async (_label, first, incoming, expected, cancels) => {
    const env = await setup();
    env.speech.say(first);
    env.speech.say(incoming);
    expect(env.engine.cancelCalls).toBe(cancels);
    drain(env);
    expect(env.engine.texts).toEqual(expected);
    expect(env.engine.overlappingSpeaks).toBe(0);
  });

  it('RESULT ngắt GUIDANCE: end của câu bị ngắt phát ngay, RESULT đọc sau khoảng lặng, phần còn lại của hướng dẫn bị bỏ', async () => {
    const env = await setup();
    env.speech.say(GUIDE('NO_MONEY'));
    expect(env.events).toEqual([ev('start', 'GUIDANCE')]);
    env.speech.say(RESULT(50000));
    expect(env.events).toEqual([ev('start', 'GUIDANCE'), ev('end', 'GUIDANCE')]);
    expect(env.engine.texts).toEqual(['Chưa nhận diện được tiền.']);
    env.sched.advance(399);
    expect(env.engine.texts).toHaveLength(1);
    env.sched.advance(1);
    expect(env.engine.texts).toEqual(['Chưa nhận diện được tiền.', 'Năm mươi nghìn đồng.']);
    drain(env);
    expect(env.engine.texts).toHaveLength(2);
  });

  it('GUIDANCE không ngắt RESULT kể cả khi RESULT đang ở khoảng lặng giữa hai câu, và không rung UNCERTAIN', async () => {
    const env = await setup();
    env.speech.say(RESULT(20000, 50000));
    env.engine.finishCurrent(); // đang ở khoảng lặng giữa câu 1 và câu 2 của RESULT
    env.speech.say(GUIDE('LOW_CONFIDENCE'));
    drain(env);
    expect(env.engine.texts.some((t) => t.startsWith('Tôi chưa'))).toBe(false);
    expect(env.haptics.events).toEqual(['SUCCESS']);
  });

  it('GUIDANCE không ngắt REPLAY đang đọc', async () => {
    const env = await setup();
    env.speech.say(RESULT(50000));
    drain(env);
    env.speech.replayLast();
    env.speech.say(GUIDE('TOO_FAR'));
    expect(env.engine.cancelCalls).toBe(0);
    drain(env);
    expect(env.engine.texts).toEqual([...R50, ...R50]);
  });

  it('ưu tiên cao hơn xóa các mục thấp hơn đang chờ nhưng giữ mục cao hơn', async () => {
    const env = await setup();
    env.speech.say(ERROR);
    env.speech.say(GUIDE('TOO_FAR'));
    env.speech.say(RESULT(50000));
    drain(env);
    expect(env.engine.texts).toEqual([...ERR, ...R50]);
  });

  it('mục bị xóa khỏi hàng đợi chưa từng được đọc nên đọc lại được ngay trong cửa sổ chống lặp', async () => {
    const env = await setup();
    env.speech.say(ERROR);
    env.speech.say(GUIDE('TOO_FAR'));
    env.speech.say(RESULT(50000));
    drain(env);
    env.speech.say(GUIDE('TOO_FAR'));
    drain(env);
    expect(env.engine.texts).toEqual([...ERR, ...R50, ...FAR]);
  });
});

describe('chống lặp, thay thế và quá hạn', () => {
  it('cùng câu trong cửa sổ chống lặp thì bỏ (cả rung); quá cửa sổ thì đọc lại', async () => {
    const env = await setup();
    env.speech.say(RESULT(50000));
    drain(env);
    env.sched.advance(1000);
    env.speech.say(RESULT(50000));
    drain(env);
    expect(env.engine.texts).toHaveLength(1);
    expect(env.haptics.events).toEqual(['SUCCESS']);
    env.sched.advance(env.config.dedupeWindowMs);
    env.speech.say(RESULT(50000));
    drain(env);
    expect(env.engine.texts).toHaveLength(2);
  });

  it('cửa sổ chống lặp tính từ lúc đọc xong, không phải lúc bắt đầu đọc', async () => {
    const env = await setup();
    env.speech.say(RESULT(50000));
    env.sched.advance(4000); // câu đọc lâu 4 giây
    env.engine.finishCurrent();
    env.sched.advance(3000); // đã 7 giây từ lúc bắt đầu nhưng mới 3 giây từ lúc đọc xong
    env.speech.say(RESULT(50000));
    drain(env);
    expect(env.engine.texts).toHaveLength(1);
  });

  it('câu đang đọc hoặc đang chờ cũng được coi là lặp', async () => {
    const env = await setup();
    env.speech.say(GUIDE('TOO_FAR'));
    env.speech.say(GUIDE('TOO_FAR'));
    drain(env);
    expect(env.engine.texts).toEqual(['Hãy đưa tiền lại gần camera hơn.']);
  });

  it('REPLAY không bị chống lặp', async () => {
    const env = await setup();
    env.speech.say(RESULT(50000));
    drain(env);
    env.speech.replayLast();
    drain(env);
    expect(env.engine.texts).toEqual(['Năm mươi nghìn đồng.', 'Năm mươi nghìn đồng.']);
  });

  it('engine từ chối câu đầu (cần unlock) thì không tính là đã đọc, thử lại được sau unlock', async () => {
    const env = await setup({ engines: [engineOf('web-speech', { requiresUserGesture: true })] });
    env.speech.say({ kind: 'WELCOME' });
    expect(env.engine.rejected).toHaveLength(1);
    expect(env.events).toEqual([ev('start', 'WELCOME'), ev('end', 'WELCOME')]);
    env.speech.unlock();
    env.speech.say({ kind: 'WELCOME' });
    env.sched.advance(env.config.minGapMs);
    expect(env.engine.texts).toEqual(['Xin chào! Hãy đưa tiền đến trước camera.']);
  });

  it('supersede: GUIDANCE mới thay GUIDANCE đang chờ, không thay câu đang đọc', async () => {
    const env = await setup();
    env.speech.say(GUIDE('TOO_FAR'));
    env.speech.say(GUIDE('HOLD_STEADY'));
    env.speech.say(GUIDE('MULTI_NOT_ALLOWED'));
    drain(env);
    expect(env.engine.texts).toEqual(['Hãy đưa tiền lại gần camera hơn.', 'Hãy đưa từng tờ một.']);
  });

  it('hai lỗi khác mã không thay thế nhau', async () => {
    const env = await setup();
    env.speech.say({ kind: 'ERROR', code: 'CAMERA_FAILED' });
    env.speech.say({ kind: 'ERROR', code: 'MODEL_CORRUPT' });
    env.speech.say({ kind: 'ERROR', code: 'STORAGE_FAILED' });
    drain(env);
    expect(env.engine.texts).toEqual([
      'Không mở được camera.', 'Hãy đóng ứng dụng rồi mở lại.', 'Dữ liệu nhận dạng bị hỏng.', 'Hãy cài lại ứng dụng.',
      'Không lưu được cài đặt.', 'Hãy kiểm tra bộ nhớ điện thoại còn trống rồi thử lại.',
    ]);
  });

  it.each([
    ['chờ quá guidanceStaleMs thì bỏ', 3500, ['Hãy đưa tiền lại gần camera hơn.']],
    ['chờ chưa quá guidanceStaleMs thì vẫn đọc', 2000, ['Hãy đưa tiền lại gần camera hơn.', 'Hãy giữ tiền yên trước camera.']],
  ])('hướng dẫn %s', async (_label, waitMs, expected) => {
    const env = await setup();
    env.speech.say(GUIDE('TOO_FAR'));
    env.speech.say(GUIDE('HOLD_STEADY'));
    env.sched.advance(waitMs);
    drain(env);
    expect(env.engine.texts).toEqual(expected);
  });

  it('quá hạn chỉ áp dụng cho hướng dẫn chưa đọc: RESULT chờ lâu và câu sau của hướng dẫn đang đọc vẫn được đọc', async () => {
    const env = await setup();
    env.speech.say({ kind: 'ERROR', code: 'CAMERA_FAILED' });
    env.speech.say(RESULT(50000));
    env.sched.advance(10000);
    drain(env);
    expect(env.engine.texts.at(-1)).toBe('Năm mươi nghìn đồng.');

    const slow = await setup({ config: { minGapMs: 5000 } });
    slow.speech.say(GUIDE('NO_MONEY'));
    slow.engine.finishCurrent();
    slow.sched.advance(5000);
    expect(slow.engine.texts).toEqual(['Chưa nhận diện được tiền.', 'Hãy đưa tiền đến trước camera.']);
  });
});

describe('sự kiện utterance: mỗi câu đúng một start và một end', () => {
  it('đọc xong tự nhiên; isSpeaking đúng từ start đến end', async () => {
    const env = await setup();
    env.speech.say(RESULT(50000));
    expect(env.speech.isSpeaking).toBe(true);
    env.engine.finishCurrent();
    expect(env.speech.isSpeaking).toBe(false);
    expect(env.events).toEqual([ev('start', 'RESULT'), ev('end', 'RESULT')]);
  });

  it('bị hủy do ưu tiên cao: đúng một end, hook muộn của engine bị bỏ qua', async () => {
    const late = new LateEngine();
    const env = await setup({ engines: [late] });
    env.speech.say(GUIDE('TOO_FAR'));
    env.speech.say(RESULT(50000));
    env.sched.advance(400);
    const [old] = late.hooks;
    old?.onEnd();
    old?.onError(new Error('muộn'));
    expect(env.events).toEqual([ev('start', 'GUIDANCE'), ev('end', 'GUIDANCE'), ev('start', 'RESULT')]);
    expect(env.speech.isSpeaking).toBe(true);
    late.hooks[1]?.onEnd();
    expect(env.events.at(-1)).toEqual(ev('end', 'RESULT'));
    expect(env.events).toHaveLength(4);
  });

  it('lỗi engine: đúng một end, bỏ phần còn lại của câu, rồi đọc mục kế tiếp', async () => {
    const env = await setup();
    env.speech.say(GUIDE('NO_MONEY'));
    env.speech.say(GUIDE('HOLD_STEADY'));
    env.engine.failCurrent();
    expect(env.events).toEqual([ev('start', 'GUIDANCE'), ev('end', 'GUIDANCE')]);
    env.sched.advance(400);
    expect(env.engine.texts).toEqual(['Chưa nhận diện được tiền.', 'Hãy giữ tiền yên trước camera.']);
  });

  it('watchdog: tự kết thúc đúng một lần ở maxUtteranceMs, hủy engine rồi đọc tiếp', async () => {
    const env = await setup();
    env.speech.say(RESULT(50000));
    env.speech.say(RESULT(100000));
    env.sched.advance(env.config.maxUtteranceMs - 1);
    expect(env.events).toEqual([ev('start', 'RESULT')]);
    env.sched.advance(1);
    expect(env.events).toEqual([ev('start', 'RESULT'), ev('end', 'RESULT')]);
    expect(env.engine.cancelCalls).toBe(1);
    expect(env.engine.isSpeaking).toBe(false);
    env.sched.advance(env.config.minGapMs);
    expect(env.engine.texts).toEqual(['Năm mươi nghìn đồng.', 'Một trăm nghìn đồng.']);
  });

  it('watchdog lấy số lớn hơn giữa maxUtteranceMs và ước lượng theo độ dài chữ', async () => {
    const env = await setup({ config: { maxUtteranceMs: 1000 } });
    const limit = utteranceTimeoutMs('Năm mươi nghìn đồng.', 1, 1000);
    expect(limit).toBeGreaterThan(1000);
    env.speech.say(RESULT(50000));
    env.sched.advance(limit - 1);
    expect(env.speech.isSpeaking).toBe(true);
    env.sched.advance(1);
    expect(env.speech.isSpeaking).toBe(false);
    expect(utteranceTimeoutMs('Năm mươi nghìn đồng.', 0.8, 1000)).toBeGreaterThan(limit);
    expect(utteranceTimeoutMs('Ngắn.', 1, 15000)).toBe(15000);
  });

  it('cancelAll: một end cho câu đang đọc, xóa hàng đợi, không đọc thêm', async () => {
    const env = await setup();
    env.speech.say(RESULT(50000));
    env.speech.say(RESULT(100000));
    env.speech.cancelAll();
    expect(env.events).toEqual([ev('start', 'RESULT'), ev('end', 'RESULT')]);
    env.sched.advance(20000);
    expect(env.engine.texts).toEqual(['Năm mươi nghìn đồng.']);
    expect(env.speech.isSpeaking).toBe(false);
  });

  it('engine.speak ném lỗi: vẫn một start và một end, các câu sau đọc bình thường', async () => {
    const env = await setup({ engines: [new ThrowOnceEngine()] });
    env.speech.say(RESULT(50000));
    expect(env.events).toEqual([ev('start', 'RESULT'), ev('end', 'RESULT')]);
    env.sched.advance(400);
    env.speech.say(RESULT(100000));
    expect(env.engine.texts).toEqual(['Một trăm nghìn đồng.']);
  });

  it('bộ nghe ném lỗi không phá hàng đợi; hủy đăng ký thì không nhận nữa', async () => {
    const env = await setup();
    env.speech.onUtterance(() => {
      throw new Error('bộ nghe hỏng');
    });
    const received: UtteranceEvent[] = [];
    const off = env.speech.onUtterance((e) => received.push(e));
    env.speech.say(RESULT(50000));
    off();
    env.engine.finishCurrent();
    expect(received).toEqual([ev('start', 'RESULT')]);
    expect(env.events).toHaveLength(2);
  });

  it('bộ nghe gọi say() ngay trong sự kiện end không gây chồng tiếng', async () => {
    const env = await setup();
    env.speech.onUtterance((e) => {
      if (e.phase === 'end' && e.kind === 'RESULT') env.speech.say(RESULT(100000));
    });
    env.speech.say(RESULT(50000));
    env.engine.finishCurrent();
    env.sched.advance(env.config.minGapMs);
    expect(env.engine.texts).toEqual(['Năm mươi nghìn đồng.', 'Một trăm nghìn đồng.']);
    expect(env.engine.overlappingSpeaks).toBe(0);
  });

  it('bộ nghe hủy ngay trong sự kiện start: không phát tiếng nào, vẫn một start và một end', async () => {
    const env = await setup();
    env.speech.onUtterance((e) => {
      if (e.phase === 'start') env.speech.cancelAll();
    });
    env.speech.say(RESULT(50000));
    expect(env.engine.spoken).toHaveLength(0);
    expect(env.events).toEqual([ev('start', 'RESULT'), ev('end', 'RESULT')]);
  });
});

describe('replayLast', () => {
  it('chưa có kết quả thì nói REPLAY_EMPTY', async () => {
    const env = await setup();
    env.speech.replayLast();
    expect(env.engine.texts).toEqual(['Hiện tại tôi chưa nhận dạng được tờ tiền nào.']);
  });

  it('đọc lại kết quả gần nhất theo verbosity hiện tại', async () => {
    const env = await setup();
    env.speech.say(RESULT(20000, 50000, 100000));
    drain(env);
    env.speech.say(RESULT(100000));
    drain(env);
    env.speech.replayLast();
    drain(env);
    expect(env.engine.texts.at(-1)).toBe('Một trăm nghìn đồng.');

    env.speech.say(RESULT(20000, 50000, 100000));
    drain(env);
    env.settings.verbosity = 'BRIEF';
    env.speech.replayLast();
    drain(env);
    expect(env.engine.texts.at(-1)).toBe('Một trăm bảy mươi nghìn đồng.');
  });

  it('kết quả không nhất quán: KHÔNG đọc số tiền, nói lời từ chối an toàn và rung UNCERTAIN; replay vẫn là kết quả hợp lệ trước đó', async () => {
    const env = await setup();
    env.speech.say(RESULT(50000));
    drain(env);
    env.haptics.clear();
    env.speech.say({ kind: 'RESULT', result: makeResult([20000, 50000], { total: 80000 }) });
    drain(env);
    expect(env.engine.texts.slice(1)).toEqual(['Tôi chưa nhận dạng rõ tờ tiền.', 'Hãy duỗi phẳng tờ tiền và đưa gần camera hơn.']);
    expect(env.haptics.events).toEqual(['UNCERTAIN']);
    env.speech.replayLast();
    drain(env);
    expect(env.engine.texts.at(-1)).toBe('Năm mươi nghìn đồng.');
  });
});

describe('voiceEnabled và rung', () => {
  const CASES: Array<[string, SpeechIntent, HapticEvent | null]> = [
    ['CAMERA_READY', { kind: 'CAMERA_READY' }, 'START'],
    ['RESULT', RESULT(50000), 'SUCCESS'],
    ['GUIDANCE LOW_CONFIDENCE', GUIDE('LOW_CONFIDENCE'), 'UNCERTAIN'],
    ['GUIDANCE CLASS_CONFLICT', GUIDE('CLASS_CONFLICT'), 'UNCERTAIN'],
    ['GUIDANCE NO_MONEY', GUIDE('NO_MONEY'), null],
    ['ERROR', { kind: 'ERROR', code: 'CAMERA_FAILED' }, 'ERROR'],
    ['WELCOME', { kind: 'WELCOME' }, null],
    ['SETTING_ACK', { kind: 'SETTING_ACK', what: 'VIBRATION_ON' }, null],
    ['REPLAY_EMPTY', { kind: 'REPLAY_EMPTY' }, null],
  ];

  it.each(CASES)('%s: bật giọng nói thì vừa đọc vừa rung theo ý định', async (_label, intent, haptic) => {
    const env = await setup();
    env.speech.say(intent);
    expect(env.engine.spoken).toHaveLength(1);
    expect(env.haptics.events).toEqual(haptic === null ? [] : [haptic]);
  });

  it.each(CASES)('%s: tắt giọng nói thì không phát âm nhưng vẫn rung', async (_label, intent, haptic) => {
    const env = await setup({ settings: { voiceEnabled: false } });
    env.speech.say(intent);
    env.sched.advance(10000);
    expect(env.engine.spoken).toHaveLength(0);
    expect(env.events).toEqual([]);
    expect(env.haptics.events).toEqual(haptic === null ? [] : [haptic]);
  });

  it('tắt giọng nói giữa chừng thì dừng đọc ngay ở lần say kế tiếp', async () => {
    const env = await setup();
    env.speech.say(RESULT(50000));
    env.settings.voiceEnabled = false;
    env.speech.say({ kind: 'WELCOME' });
    expect(env.speech.isSpeaking).toBe(false);
    expect(env.events).toEqual([ev('start', 'RESULT'), ev('end', 'RESULT')]);
  });

  it('tắt giọng nói trong lúc còn mục đang chờ thì không đọc tiếp', async () => {
    const env = await setup();
    env.speech.say(RESULT(50000));
    env.speech.say(RESULT(100000));
    env.settings.voiceEnabled = false;
    env.engine.finishCurrent();
    env.sched.advance(10000);
    expect(env.engine.texts).toEqual(['Năm mươi nghìn đồng.']);
  });

  it('bộ rung ném lỗi không làm hỏng việc đọc', async () => {
    const broken: IHaptics = {
      supported: true,
      play: () => {
        throw new Error('rung hỏng');
      },
    };
    const env = await setup({ haptics: broken });
    env.speech.say(RESULT(50000));
    expect(env.engine.texts).toEqual(['Năm mươi nghìn đồng.']);
  });
});

describe('cắt câu dài', () => {
  it.each<[string, string[]]>([
    ['Năm mươi nghìn đồng.', ['Năm mươi nghìn đồng.']],
    ['Có ba tờ tiền. Một tờ hai mươi nghìn đồng. Tổng này chỉ tính các tờ tôi nhìn thấy.', ['Có ba tờ tiền.', 'Một tờ hai mươi nghìn đồng.', 'Tổng này chỉ tính các tờ tôi nhìn thấy.']],
    ['Xin chào! Hãy đưa tiền đến trước camera.', ['Xin chào! Hãy đưa tiền đến trước camera.']],
    ['  Hai câu.   Còn nữa.  ', ['Hai câu.', 'Còn nữa.']],
    ['Không có dấu chấm', ['Không có dấu chấm']],
    ['', []],
    ['...', []],
  ])('splitIntoUtterances(%j)', (text, expected) => {
    expect(splitIntoUtterances(text)).toEqual(expected);
  });

  it('kết quả nhiều tờ đọc thành từng câu ngắn theo thứ tự, mỗi câu cách nhau minGapMs', async () => {
    const env = await setup();
    env.speech.say(RESULT(20000, 50000, 100000));
    const expected = [
      'Có ba tờ tiền.', 'Một tờ hai mươi nghìn đồng.', 'Một tờ năm mươi nghìn đồng.', 'Một tờ một trăm nghìn đồng.',
      'Tổng cộng một trăm bảy mươi nghìn đồng.', 'Tổng này chỉ tính các tờ tôi nhìn thấy.',
    ];
    for (let i = 1; i < expected.length; i += 1) {
      env.engine.finishCurrent();
      env.sched.advance(env.config.minGapMs - 1);
      expect(env.engine.texts).toHaveLength(i);
      env.sched.advance(1);
    }
    env.engine.finishCurrent();
    expect(env.engine.texts).toEqual(expected);
    expect(env.events.filter((e) => e.phase === 'start')).toHaveLength(6);
    expect(env.events.filter((e) => e.phase === 'end')).toHaveLength(6);
  });

  it('tốc độ và ngôn ngữ lấy từ cài đặt tại lúc đọc từng câu', async () => {
    const env = await setup({ settings: { speechRate: 0.8 } });
    env.speech.say(RESULT(20000, 50000));
    env.settings.speechRate = 1.2;
    env.engine.finishCurrent();
    env.sched.advance(env.config.minGapMs);
    expect(env.engine.spoken.map((u) => [u.rate, u.lang])).toEqual([[0.8, 'vi-VN'], [1.2, 'vi-VN']]);
  });
});

describe('unlock', () => {
  it('gọi unlock của mọi engine; lỗi của một engine không chặn engine khác', async () => {
    class BadUnlock extends FakeTtsEngine {
      unlock(): void {
        super.unlock();
        throw new Error('unlock hỏng');
      }
    }
    const bad = new BadUnlock();
    const good = engineOf('web-speech');
    const env = await setup({ engines: [bad, good] });
    env.speech.unlock();
    expect([bad.unlockCalls, good.unlockCalls]).toEqual([1, 1]);
  });
});

describe('không bao giờ chồng tiếng (ngẫu nhiên có hạt giống)', () => {
  const POOL: SpeechIntent[] = [
    { kind: 'WELCOME' }, { kind: 'PERMISSION_PRIMER' }, { kind: 'CAMERA_READY' }, { kind: 'REPLAY_EMPTY' },
    { kind: 'SETTING_ACK', what: 'RATE_FAST' }, { kind: 'ERROR', code: 'CAMERA_FAILED' }, { kind: 'ERROR', code: 'MODEL_CORRUPT' },
    GUIDE('NO_MONEY'), GUIDE('TOO_FAR'), GUIDE('HOLD_STEADY'), GUIDE('LOW_CONFIDENCE'), GUIDE('BLUR'),
    RESULT(50000), RESULT(100000), RESULT(20000, 50000, 100000), RESULT(10000, 10000),
  ];

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])('hạt giống %d', async (seed) => {
    const rnd = mulberry32(seed);
    const env = await setup();
    let open = 0;
    let starts = 0;
    let ends = 0;
    const violations: string[] = [];
    env.speech.onUtterance((e) => {
      if (e.phase === 'start') {
        starts += 1;
        open += 1;
      } else {
        ends += 1;
        open -= 1;
      }
      if (open < 0 || open > 1) violations.push(`open=${open} sau ${e.phase} ${e.kind}`);
    });
    for (let step = 0; step < 120; step += 1) {
      const r = rnd();
      if (r < 0.4) env.speech.say(POOL[Math.floor(rnd() * POOL.length)] ?? { kind: 'WELCOME' });
      else if (r < 0.6) env.engine.finishCurrent();
      else if (r < 0.65) env.engine.failCurrent();
      else if (r < 0.68) env.speech.cancelAll();
      else if (r < 0.74) env.speech.replayLast();
      else if (r < 0.77) env.settings.voiceEnabled = !env.settings.voiceEnabled;
      else env.sched.advance(Math.floor(rnd() * 2500));
      if (env.engine.overlappingSpeaks !== 0) violations.push(`chồng tiếng ở bước ${step}`);
      if (env.speech.isSpeaking !== env.engine.isSpeaking) violations.push(`isSpeaking lệch ở bước ${step}`);
      if (open !== (env.speech.isSpeaking ? 1 : 0)) violations.push(`start/end lệch ở bước ${step}`);
    }
    env.settings.voiceEnabled = true;
    drain(env);
    expect(violations).toEqual([]);
    expect(starts).toBe(ends);
  });
});