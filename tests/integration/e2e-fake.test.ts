// Bài kiểm tra GHÉP toàn hệ thống: createApp (P11) nối createFrameAnalyzer, createDecisionEngine, createSpeechManager THẬT
// với camera, suy luận, engine đọc, rung, kho cài đặt GIẢ. Tự bỏ qua (ghi lý do trong tên) khi một module còn là stub.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFrameAnalyzer } from '../../src/analyzer/frame-analyzer';
import { createApp } from '../../src/app/app';
import { DEFAULT_CONFIG, DEFAULT_SETTINGS } from '../../src/config/app-config';
import type { AppConfig, CapturedFrame, Denomination, Detection, GrayImage, SettingAck, Settings, SpeechIntent, UtteranceEvent } from '../../src/contracts';
import { createDecisionEngine } from '../../src/decision/decision-engine';
import { createLogger, setLogSink } from '../../src/utils/logger';
import { mulberry32 } from '../../src/utils/math';
import { createFakeClock } from '../../src/utils/time';
import { createSpeechManager } from '../../src/voice/speech-manager';
import { FakeCamera, FakeHaptics, FakeInference, FakeTtsEngine, MemorySettingsStore, makeDetection, makeInferenceResult } from '../fakes';
import { FakeLifecycle, FakeSettings, FakeUi } from '../app/app-fakes';

/** Module thật mà bài ghép cần. Hàm ném lỗi bắt đầu bằng STUB: nghĩa là module chưa được ghép. */
const REAL_MODULES: ReadonlyArray<readonly [string, () => unknown]> = [
  ['createFrameAnalyzer', () => createFrameAnalyzer(DEFAULT_CONFIG)],
  ['createDecisionEngine', () => createDecisionEngine(DEFAULT_CONFIG.decision)],
  ['createSpeechManager', () => createSpeechManager({ engines: [], haptics: new FakeHaptics(), getSettings: () => DEFAULT_SETTINGS, config: DEFAULT_CONFIG.speech })],
];
const stubs = REAL_MODULES.filter(([, make]) => {
  try {
    make();
    return false;
  } catch (e) {
    return e instanceof Error && e.message.startsWith('STUB:');
  }
}).map(([name]) => name);
const suite = stubs.length > 0 ? describe.skip : describe;
// Vitest không in tên bộ test bị bỏ qua, nên ghi lý do ra log để người chạy thấy.
if (stubs.length > 0) createLogger('e2e-fake').warn(`BỎ QUA bài ghép toàn hệ thống vì còn là stub: ${stubs.join(', ')}`);

/** Bỏ khoảng nghỉ giữa hai câu để test không cần hẹn giờ (khoảng nghỉ đã có test riêng ở P08). */
const CONFIG: AppConfig = { ...DEFAULT_CONFIG, speech: { ...DEFAULT_CONFIG.speech, minGapMs: 0 } };
const FRAME_MS = 333;
const OUT_OF_FRAME_MS = 800; // 8 khung trống ≈ 6,4 giây: lâu hơn cửa sổ chống lặp (5 giây)

/** Ảnh xám có kết cấu (không mờ, không tối) để bộ phân tích không chặn vì chất lượng ảnh. */
const rand = mulberry32(7);
const SHARP: GrayImage = { width: 64, height: 48, data: Uint8Array.from({ length: 64 * 48 }, () => Math.floor(rand() * 256)) };

const note = (f: CapturedFrame, denomination: Denomination, confidence: number, slot = 0): Detection =>
  makeDetection({
    id: `${f.meta.frameId}-${slot}`, frameId: f.meta.frameId, timestamp: f.meta.timestamp, denomination, confidence,
    bbox: { x1: 40 + slot * 280, y1: 120, x2: 280 + slot * 280, y2: 360 },
  });

async function bootSystem(initial: Partial<Settings> = {}) {
  const clock = createFakeClock(1000);
  const camera = new FakeCamera();
  const inference = new FakeInference();
  const tts = new FakeTtsEngine();
  const haptics = new FakeHaptics();
  let ack: (what: SettingAck) => void = () => undefined;
  const settings = new FakeSettings(new MemorySettingsStore(initial), (what) => ack(what));
  const speech = createSpeechManager({ engines: [tts], haptics, getSettings: () => settings.get(), config: CONFIG.speech, now: clock.now });
  ack = (what) => speech.say({ kind: 'SETTING_ACK', what });
  const intents: SpeechIntent[] = []; // mọi ý định app đã gửi cho bộ nói, kể cả những câu bị bộ nói bỏ
  const sayReal = speech.say.bind(speech);
  speech.say = (intent) => {
    intents.push(intent);
    sayReal(intent);
  };
  const decision = createDecisionEngine(CONFIG.decision);
  const ui = new FakeUi();
  const utterances: UtteranceEvent[] = [];
  speech.onUtterance((e) => utterances.push(e));
  const app = createApp({
    camera, inference, analyzer: createFrameAnalyzer(CONFIG), decision, speech, haptics, settings, ui,
    assets: async () => ({ ok: true, missing: [], warnings: [] }), platform: 'android-native', clock: clock.now,
    lifecycle: new FakeLifecycle(), config: CONFIG,
  });
  await app.start();

  const count = (phase: UtteranceEvent['phase'], kind: UtteranceEvent['kind']): number =>
    utterances.filter((e) => e.phase === phase && e.kind === kind).length;
  /** Đọc nốt mọi câu đang phát (engine giả không tự kết thúc); mỗi câu xong có thể khởi động câu kế. */
  const drain = (): void => {
    while (tts.finishCurrent()) continue;
  };
  /** Một khung hình: đồng hồ tiến `stepMs`, suy luận thấy `detect(khung)`, rồi đọc nốt các câu đang phát. */
  const frame = async (detect: (f: CapturedFrame) => Detection[], stepMs = FRAME_MS, settle = true): Promise<void> => {
    clock.advance(stepMs);
    inference.enqueue((f) => makeInferenceResult({ meta: f.meta, detections: detect(f), gray: SHARP }));
    await camera.emitFrame({ timestamp: clock.now() });
    if (settle) drain();
  };
  const frames = async (n: number, detect: (f: CapturedFrame) => Detection[], stepMs = FRAME_MS): Promise<void> => {
    for (let i = 0; i < n; i++) await frame(detect, stepMs);
  };
  drain(); // vào bài test với engine đã im
  return { app, clock, camera, tts, decision, settings, ui, utterances, intents, count, drain, frame, frames };
}
type System = Awaited<ReturnType<typeof bootSystem>>;

const fifty = (f: CapturedFrame): Detection[] => [note(f, 50000, 0.95)];
const unsure = (f: CapturedFrame): Detection[] => [note(f, 50000, 0.55)];
const none = (): Detection[] => [];

beforeAll(() => setLogSink(() => undefined));
afterAll(() => setLogSink(null));

suite(stubs.length > 0 ? `ghép toàn hệ thống — BỎ QUA vì còn là stub: ${stubs.join(', ')}` : 'ghép toàn hệ thống', () => {
  let system: System | null = null;
  const boot = async (initial: Partial<Settings> = {}): Promise<System> => (system = await bootSystem(initial));
  afterEach(() => {
    system?.app.dispose();
    system = null;
  });

  it('khởi động xong: engine ở READY, đã chào và báo camera sẵn sàng', async () => {
    const s = await boot();
    expect(s.decision.state).toBe('READY');
    const kinds = s.utterances.filter((e) => e.phase === 'start').map((e) => e.kind);
    // PERMISSION_PRIMER gồm hai câu nên có hai sự kiện liên tiếp cùng loại
    expect(kinds.filter((k, i) => k !== kinds[i - 1])).toEqual(['WELCOME', 'PERMISSION_PRIMER', 'CAMERA_READY']);
    expect(s.tts.overlappingSpeaks).toBe(0);
  });

  it('cài đặt cũ ghi đèn đang bật: mở app đèn vẫn tắt, không có lời nào lạ', async () => {
    const s = await boot({ torchEnabled: true });
    expect(s.camera.torchCalls).toBe(0);
    expect(s.settings.get().torchEnabled).toBe(false);
    expect(s.tts.texts.some((t) => /đèn/i.test(t))).toBe(false);
  });

  it('tiền 50.000đ ổn định 10 khung: đúng 1 câu RESULT', async () => {
    const s = await boot();
    await s.frames(10, fifty);
    expect(s.count('start', 'RESULT')).toBe(1);
    expect(s.tts.texts.filter((t) => /năm mươi nghìn/i.test(t))).toHaveLength(1);
    expect(s.tts.overlappingSpeaks).toBe(0);
  });

  it('một tờ độ tin cậy 0,55: không có RESULT, có hướng dẫn', async () => {
    const s = await boot();
    await s.frames(10, unsure);
    expect(s.count('start', 'RESULT')).toBe(0);
    expect(s.count('start', 'GUIDANCE')).toBeGreaterThan(0);
  });

  it('đưa tiền ra rồi vào: đọc lại', async () => {
    const s = await boot();
    await s.frames(6, fifty);
    expect(s.count('start', 'RESULT')).toBe(1);
    await s.frames(8, none, OUT_OF_FRAME_MS);
    await s.frames(6, fifty);
    expect(s.count('start', 'RESULT')).toBe(2);
  });

  it('chạm nghe lại: đọc REPLAY đúng câu kết quả vừa rồi', async () => {
    const s = await boot();
    await s.frames(6, fifty);
    const first = s.tts.texts.find((t) => /năm mươi nghìn/i.test(t));
    s.ui.emit('REPLAY');
    expect(s.count('start', 'REPLAY')).toBe(1);
    expect(s.tts.texts.at(-1)).toBe(first);
  });

  it('hướng dẫn không ngắt kết quả (nhiều tờ) đang đọc dở', async () => {
    const s = await boot();
    const two = (f: CapturedFrame): Detection[] => [note(f, 20000, 0.95, 0), note(f, 50000, 0.95, 1)];
    for (let i = 0; i < 8 && s.count('start', 'RESULT') === 0; i++) await s.frame(two, FRAME_MS, false);
    expect(s.count('start', 'RESULT')).toBe(1);
    s.tts.finishCurrent(); // xong câu đầu, kết quả còn nhiều câu phải đọc
    await s.frame(unsure, FRAME_MS, false); // giữa lúc đọc, một tờ chưa chắc xuất hiện
    expect(s.intents.some((i) => i.kind === 'GUIDANCE')).toBe(true); // engine đã đề nghị nói hướng dẫn...
    expect(s.count('start', 'GUIDANCE')).toBe(0); // ...nhưng bộ nói không để nó chen vào kết quả
    s.drain();
    expect(s.tts.texts.join(' ')).toMatch(/bảy mươi nghìn/i); // kết quả được đọc trọn vẹn
    expect(s.tts.overlappingSpeaks).toBe(0);
    s.clock.advance(DEFAULT_CONFIG.decision.guidanceCooldownMs + 1);
    await s.frames(2, unsure);
    expect(s.count('start', 'GUIDANCE')).toBeGreaterThan(0); // bị chặn lúc đang đọc chứ không hỏng
  });
});