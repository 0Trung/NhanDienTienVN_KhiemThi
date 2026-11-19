import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADAPTIVE_FPS, INFERENCE_FAILURE_LIMIT, createApp } from '../../src/app/app';
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import { AppError } from '../../src/contracts';
import type { AppErrorCode, CapturedFrame, DecisionInput, DecisionOutput, RecognitionResult, UtteranceEvent } from '../../src/contracts';
import { setLogSink } from '../../src/utils/logger';
import { makeInferenceResult } from '../fakes';
import { flush, makeDeps } from './app-fakes';
import type { HarnessOptions } from './app-fakes';

beforeAll(() => setLogSink(() => undefined)); // im lặng log để thấy kết quả test
afterAll(() => setLogSink(null));

const RESULT: RecognitionResult = { status: 'CONFIDENT_SINGLE', count: 1, denominations: [50000], total: 50000, formattedTotal: '50.000 đồng', timestamp: 0 };
const count = (xs: readonly string[], x: string): number => xs.filter((e) => e === x).length;
const isAnalysis = (i: DecisionInput): boolean => i.type === 'ANALYSIS';

/** Dựng app và chạy xong trình tự khởi động (không có cổng chờ chạm). */
async function started(o: HarnessOptions = {}) {
  const t = makeDeps(o);
  const app = createApp(t.deps);
  await app.start();
  return { ...t, app };
}

/** Bước suy luận giả tốn `ms` mili-giây trên đồng hồ giả. */
const slowStep = (clock: { advance(ms: number): void }, ms: number) => (frame: CapturedFrame) => {
  clock.advance(ms);
  return makeInferenceResult({ meta: frame.meta });
};

describe('khởi động', () => {
  it('đúng thứ tự sự kiện khi không cần chạm', async () => {
    const t = await started();
    expect(t.decision.events.slice(0, 3)).toEqual(['APP_STARTED', 'GESTURE_UNLOCKED', 'PERMISSION_REQUESTED']);
    expect([...t.decision.events.slice(3)].sort()).toEqual(['CAMERA_READY', 'MODEL_READY']);
    expect(t.speech.unlockCalls).toBe(0);
    expect(t.ui.calls).not.toContain('showStartGate');
    expect(t.camera.samplingFps).toBe(DEFAULT_CONFIG.inference.targetFps);
    expect(t.speech.intents.map((i) => i.kind)).toEqual(['WELCOME', 'PERMISSION_PRIMER']);
  });

  it('nói PERMISSION_PRIMER trước khi mở camera, và camera.start chạy song song với nạp mô hình', async () => {
    const t = makeDeps();
    const order: string[] = [];
    const say = t.speech.say.bind(t.speech);
    vi.spyOn(t.speech, 'say').mockImplementation((i) => (order.push(`say:${i.kind}`), say(i)));
    const start = t.camera.start.bind(t.camera);
    vi.spyOn(t.camera, 'start').mockImplementation(() => (order.push('camera.start'), start()));
    const init = t.inference.init.bind(t.inference);
    vi.spyOn(t.inference, 'init').mockImplementation(() => (order.push('inference.init'), init()));
    await createApp(t.deps).start();
    expect(order.indexOf('say:PERMISSION_PRIMER')).toBeLessThan(order.indexOf('camera.start'));
    expect(order.slice(-2)).toEqual(['inference.init', 'camera.start']); // cả hai được gọi trước khi chờ kết quả của nhau
  });

  it.each<[string, HarnessOptions]>([
    ['engine đòi một lần chạm', { speechCaps: { requiresUserGesture: true } }],
    ['người dùng tắt "Tự bật camera"', { settings: { autoStartCamera: false } }],
  ])('hiện cổng và chờ chạm: %s', async (_name, o) => {
    const t = makeDeps(o);
    const done = createApp(t.deps).start();
    await flush();
    expect(t.ui.gate).not.toBeNull();
    expect(t.decision.events).toEqual(['APP_STARTED']);
    expect(t.camera.startCalls).toBe(0);
    expect(t.speech.intents).toEqual([]); // lời chào chưa được nói khi giọng chưa mở khóa
    t.ui.tapGate();
    await done;
    expect(t.speech.unlockCalls).toBe(1);
    expect(t.speech.intents[0]).toEqual({ kind: 'WELCOME' });
    expect(t.decision.events.slice(0, 3)).toEqual(['APP_STARTED', 'GESTURE_UNLOCKED', 'PERMISSION_REQUESTED']);
    expect(t.camera.startCalls).toBe(1);
  });

  it('thiếu tài nguyên: FAILURE OFFLINE_NOT_READY, nói lỗi, hiện màn hình lỗi, không mở camera', async () => {
    const t = await started({ assets: { ok: false, missing: ['models/best.onnx'], warnings: [] } });
    expect(t.decision.inputs.map((i) => i.type)).toEqual(['FAILURE']);
    expect(t.speech.intents).toEqual([{ kind: 'ERROR', code: 'OFFLINE_NOT_READY' }]);
    expect(t.ui.errors.map((e) => e.code)).toEqual(['OFFLINE_NOT_READY']);
    expect(t.camera.startCalls).toBe(0);
  });

  it('kiểm tra gói ném lỗi thì cũng coi là thiếu tài nguyên', async () => {
    const t = await started({ assets: new Error('fetch hỏng') });
    expect(t.ui.errors.map((e) => e.code)).toEqual(['OFFLINE_NOT_READY']);
  });

  it.each<[string, HarnessOptions, AppErrorCode]>([
    ['camera bị từ chối quyền', { camera: { startError: new AppError('CAMERA_PERMISSION_DENIED', 'x', true) } }, 'CAMERA_PERMISSION_DENIED'],
    ['camera đang bị app khác dùng', { camera: { startError: new AppError('CAMERA_IN_USE', 'x', true) } }, 'CAMERA_IN_USE'],
    ['mô hình không nạp được', { modelError: new AppError('MODEL_INIT_FAILED', 'x', true) }, 'MODEL_INIT_FAILED'],
    ['mô hình bị hỏng', { modelError: new AppError('MODEL_CORRUPT', 'x', true) }, 'MODEL_CORRUPT'],
  ])('lỗi %s: có FAILURE, có nói, có màn hình lỗi, dừng camera', async (_name, o, code) => {
    const t = await started(o);
    expect(t.decision.inputs).toContainEqual(expect.objectContaining({ type: 'FAILURE', code }));
    expect(t.speech.ofKind('ERROR')).toEqual([{ kind: 'ERROR', code }]);
    expect(t.ui.errors.map((e) => e.code)).toEqual([code]);
    expect(t.ui.screen).toBe('error');
    expect(t.camera.stopCalls).toBeGreaterThan(0);
    await t.camera.emitFrame();
    expect(t.inference.inferCalls).toBe(0); // vòng quét không chạy sau lỗi
  });

  it('không có giọng tiếng Việt: nói lỗi nhưng vẫn chạy', async () => {
    const t = await started({ speechCaps: { vietnameseVoice: false } });
    expect(t.speech.ofKind('ERROR')).toEqual([{ kind: 'ERROR', code: 'TTS_NO_VIETNAMESE_VOICE' }]);
    expect(t.decision.inputs.some((i) => i.type === 'FAILURE')).toBe(false);
    expect(t.speech.intents[0]).toEqual({ kind: 'ERROR', code: 'TTS_NO_VIETNAMESE_VOICE' }); // nói trước lời chào
    expect(t.decision.events).toContain('CAMERA_READY');
  });

  it('không có giọng nói nào: báo TTS_UNAVAILABLE', async () => {
    const t = await started({ speechCaps: { available: false } });
    expect(t.ui.errors.map((e) => e.code)).toEqual(['TTS_UNAVAILABLE']);
  });

  it('start gọi hai lần chỉ chạy một lần', async () => {
    const t = await started();
    await t.app.start();
    expect(count(t.decision.events, 'APP_STARTED')).toBe(1);
  });

  it('dispose khi đang chờ cổng thì start thoát, không treo', async () => {
    const t = makeDeps({ speechCaps: { requiresUserGesture: true } });
    const app = createApp(t.deps);
    const done = app.start();
    await flush();
    app.dispose();
    await done;
    expect(t.camera.startCalls).toBe(0);
  });
});

describe('vòng quét', () => {
  it('infer trả null thì không gọi analyzer', async () => {
    const t = await started();
    t.inference.enqueue(null);
    await t.camera.emitFrame();
    expect(t.inference.inferCalls).toBe(1);
    expect(t.analyzer.analyzed).toHaveLength(0);
    expect(t.decision.inputs.some(isAnalysis)).toBe(false);
  });

  it('khung bình thường: phân tích, hỏi quyết định với now của đồng hồ, nói đúng điều engine bảo, cập nhật giao diện', async () => {
    const t = await started();
    t.decision.script = (i): Partial<DecisionOutput> =>
      isAnalysis(i) ? { state: 'SPEAKING', status: 'CONFIDENT_SINGLE', speech: { kind: 'RESULT', result: RESULT }, result: RESULT } : {};
    t.clock.advance(500);
    await t.camera.emitFrame();
    expect(t.analyzer.analyzed).toHaveLength(1);
    expect(t.decision.inputs.filter(isAnalysis)).toEqual([expect.objectContaining({ now: t.clock.now() })]);
    expect(t.speech.lastIntent).toEqual({ kind: 'RESULT', result: RESULT });
    const view = t.ui.views.at(-1);
    expect(view).toMatchObject({ state: 'SPEAKING', status: 'CONFIDENT_SINGLE', result: RESULT });
    expect(view?.frame).toMatchObject({ samplingFps: DEFAULT_CONFIG.inference.targetFps });
    expect(t.camera.openBitmaps).toBe(0);
  });

  it('lỗi suy luận không nghiêm trọng: bỏ khung, vòng quét vẫn chạy', async () => {
    const t = await started();
    t.inference.enqueue(new AppError('INFERENCE_FAILED', 'một khung'));
    await t.camera.emitFrame();
    await t.camera.emitFrame();
    expect(t.analyzer.analyzed).toHaveLength(1);
    expect(t.ui.screen).toBe('camera');
  });

  it('lỗi suy luận nghiêm trọng: báo lỗi', async () => {
    const t = await started();
    t.inference.enqueue(new AppError('INFERENCE_FAILED', 'worker chết', true));
    await t.camera.emitFrame();
    expect(t.ui.errors.map((e) => e.code)).toEqual(['INFERENCE_FAILED']);
    expect(t.inference.disposeCalls).toBeGreaterThan(0);
  });

  it.each<[string, number, boolean]>([
    ['đủ số lần liên tiếp', INFERENCE_FAILURE_LIMIT, true],
    ['chưa đủ số lần liên tiếp', INFERENCE_FAILURE_LIMIT - 1, false],
  ])('lỗi suy luận liên tiếp %s', async (_name, errors, expected) => {
    const t = await started();
    for (let i = 0; i < errors; i++) t.inference.enqueue(new AppError('INFERENCE_FAILED', 'lỗi nhẹ'));
    for (let i = 0; i < errors; i++) await t.camera.emitFrame();
    expect(t.ui.screen === 'error').toBe(expected);
  });

  it('một khung tốt ngắt chuỗi lỗi liên tiếp', async () => {
    const t = await started();
    const bad = (): AppError => new AppError('INFERENCE_FAILED', 'lỗi nhẹ');
    t.inference.enqueue(bad(), bad(), bad(), bad(), null, bad(), bad(), bad(), bad());
    for (let i = 0; i < 9; i++) await t.camera.emitFrame();
    expect(t.ui.screen).toBe('camera');
  });

  it('hạ fps một bậc khi độ trễ trung bình vượt 2 lần khoảng cách lấy mẫu, rồi dừng ở mức sàn', async () => {
    const t = await started();
    const fps = DEFAULT_CONFIG.inference.targetFps;
    const batch = async (): Promise<void> => {
      t.inference.enqueue(...Array.from({ length: ADAPTIVE_FPS.window }, () => slowStep(t.clock, 5000)));
      for (let i = 0; i < ADAPTIVE_FPS.window; i++) await t.camera.emitFrame();
    };
    expect(t.camera.samplingFps).toBe(fps);
    for (let step = 1; step <= fps; step++) {
      await batch();
      expect(t.camera.samplingFps).toBe(Math.max(ADAPTIVE_FPS.minFps, fps - step * ADAPTIVE_FPS.step));
    }
  });

  it('độ trễ thấp thì giữ nguyên fps', async () => {
    const t = await started();
    t.inference.enqueue(...Array.from({ length: ADAPTIVE_FPS.window * 2 }, () => slowStep(t.clock, 10)));
    for (let i = 0; i < ADAPTIVE_FPS.window * 2; i++) await t.camera.emitFrame();
    expect(t.camera.samplingFps).toBe(DEFAULT_CONFIG.inference.targetFps);
  });
});

describe('lời nói và thao tác', () => {
  it.each<[UtteranceEvent['phase'], UtteranceEvent['kind'], number]>([
    ['end', 'RESULT', 1], ['end', 'REPLAY', 1],
    ['end', 'GUIDANCE', 0], ['end', 'ERROR', 0], ['end', 'SETTING_ACK', 0], ['end', 'WELCOME', 0],
    ['start', 'RESULT', 0], ['start', 'REPLAY', 0],
  ])('RESULT_SPEECH_ENDED khi %s %s: %i lần', async (phase, kind, expected) => {
    const t = await started();
    t.speech.emitUtterance({ phase, kind });
    expect(count(t.decision.events, 'RESULT_SPEECH_ENDED')).toBe(expected);
  });

  it('chạm nghe lại: gửi USER_REPLAY rồi nói điều engine bảo', async () => {
    const t = await started();
    t.ui.emit('REPLAY');
    expect(t.decision.inputs.at(-1)).toMatchObject({ type: 'USER_REPLAY', now: t.clock.now() });
    expect(t.speech.lastIntent).toEqual({ kind: 'REPLAY_EMPTY' });
  });

  it('bật rồi tắt đèn: camera.setTorch, lưu cài đặt, nói ack, nút phản ánh đèn thật', async () => {
    const t = await started();
    t.ui.emit('TOGGLE_TORCH');
    await flush();
    expect(t.camera.torchOn).toBe(true);
    expect(t.settings.get().torchEnabled).toBe(true);
    expect(t.speech.ofKind('SETTING_ACK')).toEqual([{ kind: 'SETTING_ACK', what: 'TORCH_ON' }]);
    expect(t.ui.torch).toEqual({ supported: true, on: true });
    t.ui.emit('TOGGLE_TORCH');
    await flush();
    expect(t.camera.torchOn).toBe(false);
    expect(t.speech.lastIntent).toEqual({ kind: 'SETTING_ACK', what: 'TORCH_OFF' });
    expect(t.ui.torch).toEqual({ supported: true, on: false });
  });

  it('đèn không hỗ trợ: nói TORCH_UNSUPPORTED, không đổi cài đặt', async () => {
    const t = await started({ camera: { torchSupported: false } });
    t.ui.emit('TOGGLE_TORCH');
    await flush();
    expect(t.speech.ofKind('SETTING_ACK')).toEqual([{ kind: 'SETTING_ACK', what: 'TORCH_UNSUPPORTED' }]);
    expect(t.settings.patches).toEqual([]);
    expect(t.ui.torch).toEqual({ supported: false, on: false });
  });

  it.each<[string, HarnessOptions]>([
    ['mặc định', {}],
    ['cài đặt cũ ghi đèn đang bật', { settings: { torchEnabled: true } }],
  ])('app không tự bật đèn khi mở: %s', async (_name, o) => {
    const t = await started(o);
    expect(t.camera.torchCalls).toBe(0);
    expect(t.settings.get().torchEnabled).toBe(false);
    expect(t.speech.ofKind('SETTING_ACK').map((i) => i.what).filter((w) => w === 'TORCH_ON')).toEqual([]);
  });

  it('đổi cách đọc thì chọn lại engine giọng nói; đổi cài đặt khác thì không', async () => {
    const t = await started();
    expect(t.speech.initCalls).toBe(1);
    await t.settings.set({ fontScale: 1.5 });
    await flush();
    expect(t.speech.initCalls).toBe(1);
    await t.settings.set({ speechOutput: 'SCREEN_READER' });
    await flush();
    expect(t.speech.initCalls).toBe(2);
  });
});

describe('vòng đời và màn hình', () => {
  it('ẩn: tạm dừng camera, hủy lời nói, rồi gửi APP_BACKGROUNDED (đúng thứ tự)', async () => {
    const t = await started();
    const order: string[] = [];
    vi.spyOn(t.camera, 'pause').mockImplementation(() => void order.push('camera.pause'));
    vi.spyOn(t.speech, 'cancelAll').mockImplementation(() => void order.push('speech.cancelAll'));
    const handle = t.decision.handle.bind(t.decision);
    vi.spyOn(t.decision, 'handle').mockImplementation((i) => {
      if (i.type === 'SYSTEM') order.push(i.event);
      return handle(i);
    });
    t.lifecycle.setVisible(false);
    expect(order).toEqual(['camera.pause', 'speech.cancelAll', 'APP_BACKGROUNDED']);
  });

  it('hiện lại: tiếp tục camera, xóa cửa sổ ổn định, gửi APP_FOREGROUNDED, rung báo', async () => {
    const t = await started();
    t.lifecycle.setVisible(false);
    t.lifecycle.setVisible(true);
    expect(t.camera.resumeCalls).toBe(1);
    expect(t.analyzer.resetCalls).toBe(1);
    expect(t.decision.events.slice(-2)).toEqual(['APP_BACKGROUNDED', 'APP_FOREGROUNDED']);
    expect(t.haptics.events).toEqual(['START']);
  });

  it('hai nguồn báo trùng thì chỉ hành động một lần', async () => {
    const t = await started();
    t.lifecycle.setVisible(false);
    t.lifecycle.setVisible(false);
    t.lifecycle.setVisible(true);
    t.lifecycle.setVisible(true);
    expect(t.camera.pauseCalls).toBe(1);
    expect(t.camera.resumeCalls).toBe(1);
    expect(count(t.decision.events, 'APP_BACKGROUNDED')).toBe(1);
    expect(count(t.decision.events, 'APP_FOREGROUNDED')).toBe(1);
  });

  it('mở cài đặt thì tạm dừng quét, đóng lại thì quét tiếp', async () => {
    const t = await started();
    t.ui.emit('OPEN_SETTINGS');
    expect(t.ui.screen).toBe('settings');
    expect(t.camera.pauseCalls).toBe(1);
    t.ui.emit('CLOSE_SETTINGS');
    expect(t.ui.screen).toBe('camera');
    expect(t.camera.resumeCalls).toBe(1);
    expect(t.analyzer.resetCalls).toBe(1);
  });

  it('ẩn rồi hiện khi đang ở màn cài đặt thì camera vẫn tạm dừng', async () => {
    const t = await started();
    t.ui.emit('OPEN_SETTINGS');
    t.lifecycle.setVisible(false);
    t.lifecycle.setVisible(true);
    expect(t.camera.resumeCalls).toBe(0);
    expect(t.haptics.events).toEqual([]);
  });

  it.each<[string, boolean, string, number]>([
    ['đang ở màn cài đặt: về màn camera, không thu nhỏ', true, 'camera', 0],
    ['đang ở màn camera: thu nhỏ app, không thoát', false, 'camera', 1],
  ])('nút Back %s', async (_name, inSettings, screen, minimized) => {
    const t = await started();
    if (inSettings) t.ui.emit('OPEN_SETTINGS');
    t.lifecycle.pressBack();
    await flush();
    expect(t.ui.screen).toBe(screen);
    expect(t.lifecycle.minimizeCalls).toBe(minimized);
  });

  it('chạy trên web thì không nghe nút Back', async () => {
    const t = await started({ platform: 'web' });
    t.lifecycle.pressBack();
    await flush();
    expect(t.lifecycle.minimizeCalls).toBe(0);
  });

  it('camera mất giữa chừng thì báo lỗi, không im lặng', async () => {
    const t = await started();
    t.camera.setStatus('ERROR', new AppError('CAMERA_IN_USE', 'mất camera', true));
    expect(t.ui.errors.map((e) => e.code)).toEqual(['CAMERA_IN_USE']);
    expect(t.speech.lastIntent).toEqual({ kind: 'ERROR', code: 'CAMERA_IN_USE' });
  });

  it('Thử lại: làm lại từ đầu, không hiện lại cổng, không trùng màn hình lỗi', async () => {
    const t = await started({ camera: { startError: new AppError('CAMERA_FAILED', 'x', true) } });
    expect(t.ui.screen).toBe('error');
    t.camera.startError = null;
    t.ui.emit('RETRY');
    await flush();
    expect(t.decision.resetCalls).toBe(1);
    expect(t.analyzer.resetCalls).toBe(1);
    expect(t.ui.screen).toBe('camera');
    expect(count(t.decision.events, 'APP_STARTED')).toBe(2);
    expect(t.camera.startCalls).toBe(2);
    expect(t.ui.errors).toHaveLength(1);
    await t.camera.emitFrame();
    expect(t.analyzer.analyzed).toHaveLength(1);
  });
});

describe('dispose', () => {
  it('gỡ mọi listener và dừng mọi thứ; gọi lại vẫn an toàn', async () => {
    const t = await started();
    t.app.dispose();
    t.app.dispose();
    expect([t.ui.listeners, t.lifecycle.listeners, t.settings.listeners]).toEqual([0, 0, 0]);
    expect(t.camera.stopCalls).toBeGreaterThan(0);
    expect(t.inference.disposeCalls).toBeGreaterThan(0);
    const before = t.decision.inputs.length;
    await t.camera.emitFrame();
    t.speech.emitUtterance({ phase: 'end', kind: 'RESULT' });
    t.ui.emit('REPLAY');
    t.lifecycle.setVisible(false);
    t.camera.setStatus('ERROR', new AppError('CAMERA_FAILED', 'x', true));
    expect(t.inference.inferCalls).toBe(0);
    expect(t.decision.inputs).toHaveLength(before);
    await t.app.start();
    expect(t.camera.startCalls).toBe(1);
  });

  it('tắt đèn qua cổng đèn native khi dừng', async () => {
    const calls: boolean[] = [];
    const torchPort = { isSupported: async () => true, set: async (on: boolean) => (calls.push(on), true) };
    const t = await started({ torchPort });
    t.ui.emit('TOGGLE_TORCH');
    await flush();
    t.app.dispose();
    await flush();
    expect(calls).toEqual([false]);
  });
});