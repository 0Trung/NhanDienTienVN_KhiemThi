import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_SETTINGS } from '../../src/config/app-config';
import { AppError } from '../../src/contracts';
import type { CameraStatus, FrameAnalysis, UtteranceEvent } from '../../src/contracts';
import { center } from '../../src/utils/geometry';
import {
  FakeCamera,
  FakeHaptics,
  FakeInference,
  FakeSpeech,
  FakeTtsEngine,
  MemorySettingsStore,
  makeAnalysis,
  makeConflictAnalysis,
  makeDetection,
  makeInferenceResult,
  makeOverlapAnalysis,
  makeSingleSureAnalysis,
  makeStableAnalysis,
  makeUnsureAnalysis,
} from './index';

const SPEAK_OPTS = { rate: 1, lang: 'vi-VN' };

function makeHooks() {
  return { onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
}

describe('FakeTtsEngine', () => {
  it('speak báo onStart ngay và chỉ báo onEnd khi finishCurrent', () => {
    const engine = new FakeTtsEngine();
    const hooks = makeHooks();
    engine.speak('xin chào', SPEAK_OPTS, hooks);
    expect(hooks.onStart).toHaveBeenCalledTimes(1);
    expect(hooks.onEnd).not.toHaveBeenCalled();
    expect(engine.isSpeaking).toBe(true);

    expect(engine.finishCurrent()).toBe(true);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
    expect(engine.isSpeaking).toBe(false);
    expect(engine.texts).toEqual(['xin chào']);
  });

  it('finishCurrent khi không có câu nào trả false', () => {
    expect(new FakeTtsEngine().finishCurrent()).toBe(false);
  });

  it('requiresUserGesture: từ chối phát cho tới khi unlock', () => {
    const engine = new FakeTtsEngine({ capabilities: { requiresUserGesture: true } });
    const locked = makeHooks();
    engine.speak('một', SPEAK_OPTS, locked);
    expect(locked.onError).toHaveBeenCalledTimes(1);
    expect(locked.onStart).not.toHaveBeenCalled();
    expect(engine.rejected).toHaveLength(1);

    engine.unlock();
    const unlocked = makeHooks();
    engine.speak('hai', SPEAK_OPTS, unlocked);
    expect(unlocked.onStart).toHaveBeenCalledTimes(1);
    expect(engine.spoken).toHaveLength(1);
  });

  it('speak chồng lên câu đang phát được đếm vào overlappingSpeaks', () => {
    const engine = new FakeTtsEngine();
    engine.speak('một', SPEAK_OPTS, makeHooks());
    engine.speak('hai', SPEAK_OPTS, makeHooks());
    expect(engine.overlappingSpeaks).toBe(1);
  });

  it('cancel bỏ câu hiện tại mà không gọi onEnd', () => {
    const engine = new FakeTtsEngine();
    const hooks = makeHooks();
    engine.speak('một', SPEAK_OPTS, hooks);
    engine.cancel();
    expect(engine.isSpeaking).toBe(false);
    expect(hooks.onEnd).not.toHaveBeenCalled();
    expect(engine.cancelCalls).toBe(1);
  });

  it('init trả năng lực đã cấu hình', async () => {
    const engine = new FakeTtsEngine({ capabilities: { vietnameseVoice: false } });
    expect((await engine.init()).vietnameseVoice).toBe(false);
  });
});

describe('FakeCamera', () => {
  it('đếm bitmap đã close khi bên nhận đóng bitmap', async () => {
    const camera = new FakeCamera();
    camera.onFrame((frame) => frame.bitmap.close());
    await camera.emitFrame();
    expect(camera.createdBitmaps).toBe(1);
    expect(camera.closedBitmaps).toBe(1);
    expect(camera.openBitmaps).toBe(0);
  });

  it('bitmap không được đóng thì vẫn còn mở', async () => {
    const camera = new FakeCamera();
    camera.onFrame(() => undefined);
    await camera.emitFrame();
    expect(camera.openBitmaps).toBe(1);
  });

  it('emitFrame chờ handler async xong mới trả về', async () => {
    const camera = new FakeCamera();
    const order: string[] = [];
    camera.onFrame(async () => {
      await Promise.resolve();
      order.push('handler xong');
    });
    await camera.emitFrame();
    order.push('emitFrame trả về');
    expect(order).toEqual(['handler xong', 'emitFrame trả về']);
  });

  it('hàm hủy của onFrame ngừng gửi khung', async () => {
    const camera = new FakeCamera();
    const handler = vi.fn();
    const unsubscribe = camera.onFrame(handler);
    await camera.emitFrame();
    unsubscribe();
    await camera.emitFrame();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('start lỗi: ném AppError và chuyển sang ERROR', async () => {
    const camera = new FakeCamera({ startError: new AppError('CAMERA_PERMISSION_DENIED', 'bị từ chối', true) });
    const seen: CameraStatus[] = [];
    camera.onStatus((s) => seen.push(s));
    await expect(camera.start()).rejects.toBeInstanceOf(AppError);
    expect(seen).toEqual(['REQUESTING', 'ERROR']);
    expect(camera.status).toBe('ERROR');
  });

  it('start thành công đi qua REQUESTING rồi ACTIVE', async () => {
    const camera = new FakeCamera();
    const seen: CameraStatus[] = [];
    camera.onStatus((s) => seen.push(s));
    await camera.start();
    expect(seen).toEqual(['REQUESTING', 'ACTIVE']);
  });

  it('setTorch trả false khi không hỗ trợ đèn', async () => {
    const camera = new FakeCamera({ torchSupported: false });
    expect(await camera.setTorch(true)).toBe(false);
    expect(camera.torchOn).toBe(false);
  });
});

describe('FakeInference', () => {
  it('trả kịch bản theo hàng đợi rồi tới kết quả rỗng, và luôn close bitmap', async () => {
    const camera = new FakeCamera();
    const inference = new FakeInference();
    await inference.init();
    const scripted = makeInferenceResult({ detections: [makeDetection()] });
    inference.enqueue(scripted, null, new AppError('INFERENCE_FAILED', 'hỏng'));

    expect(await inference.infer(await camera.emitFrame())).toBe(scripted);
    expect(await inference.infer(await camera.emitFrame())).toBeNull();
    await expect(inference.infer(await camera.emitFrame())).rejects.toBeInstanceOf(AppError);
    const fallback = await inference.infer(await camera.emitFrame());
    expect(fallback?.detections).toEqual([]);
    expect(camera.closedBitmaps).toBe(4);
    expect(inference.inferred).toHaveLength(4);
  });

  it('bước dạng hàm nhận được khung hiện tại', async () => {
    const camera = new FakeCamera();
    const inference = new FakeInference();
    await inference.init();
    inference.enqueue((frame) => makeInferenceResult({ meta: frame.meta }));
    const frame = await camera.emitFrame({ frameId: 42 });
    expect((await inference.infer(frame))?.meta.frameId).toBe(42);
  });

  it('infer trước init ném INFERENCE_FAILED', async () => {
    const camera = new FakeCamera();
    const inference = new FakeInference();
    await expect(inference.infer(await camera.emitFrame())).rejects.toMatchObject({ code: 'INFERENCE_FAILED' });
    expect(camera.closedBitmaps).toBe(1);
  });

  it('initError làm init ném lỗi và ready giữ false', async () => {
    const inference = new FakeInference({ initError: new AppError('MODEL_MISSING', 'thiếu model', true) });
    await expect(inference.init()).rejects.toBeInstanceOf(AppError);
    expect(inference.ready).toBe(false);
  });
});

describe('makeDetection', () => {
  it('suy ra id và classId từ khung và mệnh giá', () => {
    const d = makeDetection({ frameId: 7, denomination: 50000 });
    expect(d.id).toBe('7-0');
    expect(d.classId).toBe(5);
    expect(d.denomination).toBe(50000);
  });

  it('giữ giá trị ghi đè', () => {
    expect(makeDetection({ confidence: 0.3 }).confidence).toBe(0.3);
  });
});

describe('makeAnalysis và các khung dựng sẵn', () => {
  it('mặc định là khung không có tiền', () => {
    const a = makeAnalysis();
    expect(a.detections).toHaveLength(0);
    expect(a.sure).toHaveLength(0);
    expect(a.unsure).toHaveLength(0);
    expect(a.emptyStreak).toBeGreaterThan(0);
    expect(a.overlap.detected).toBe(false);
    expect(a.conflict.detected).toBe(false);
  });

  it('ghi đè thay thế nguyên trường', () => {
    const a = makeAnalysis({ quality: { blurScore: 1, blurry: true, brightness: 5, lowLight: true } });
    expect(a.quality.blurry).toBe(true);
    expect(a.position.partial).toBe(false);
  });

  it('khung một tờ chắc: detection nằm trong sure, không có unsure', () => {
    const a = makeSingleSureAnalysis(50000);
    expect(a.sure).toHaveLength(1);
    expect(a.unsure).toHaveLength(0);
    expect(a.detections).toEqual(a.sure);
    expect(a.sure[0]?.denomination).toBe(50000);
    expect(a.sure[0]?.confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIG.inference.confSure);
  });

  it('khung có tờ chưa chắc: nằm trong [confLow, confSure)', () => {
    const a = makeUnsureAnalysis();
    expect(a.sure).toHaveLength(0);
    expect(a.unsure).toHaveLength(1);
    const confidence = a.unsure[0]?.confidence ?? 0;
    expect(confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIG.inference.confLow);
    expect(confidence).toBeLessThan(DEFAULT_CONFIG.inference.confSure);
  });

  it('khung chồng lấn: cờ bật, một cặp, tỷ lệ vượt ngưỡng cấu hình', () => {
    const a = makeOverlapAnalysis();
    expect(a.overlap.detected).toBe(true);
    expect(a.overlap.pairs).toHaveLength(1);
    expect(a.overlap.maxRatio).toBeGreaterThan(DEFAULT_CONFIG.analyzer.overlapRatio);
  });

  it('khung xung đột: cùng vị trí, khác mệnh giá', () => {
    const a = makeConflictAnalysis();
    expect(a.conflict.detected).toBe(true);
    expect(a.detections[0]?.bbox).toEqual(a.detections[1]?.bbox);
    expect(a.detections[0]?.denomination).not.toBe(a.detections[1]?.denomination);
  });

  it('khung ổn định: đủ số khung đồng thuận và có consensus', () => {
    const a = makeStableAnalysis([20000, 50000]);
    expect(a.stability.stable).toBe(true);
    expect(a.stability.agree).toBeGreaterThanOrEqual(DEFAULT_CONFIG.analyzer.stabilizer.minAgree);
    expect(a.stability.consensus).toEqual(a.detections);
  });

  const builders: Array<[string, () => FrameAnalysis]> = [
    ['một tờ chắc', () => makeSingleSureAnalysis()],
    ['chưa chắc', () => makeUnsureAnalysis()],
    ['chồng lấn', () => makeOverlapAnalysis()],
    ['xung đột', () => makeConflictAnalysis()],
    ['ổn định ba tờ', () => makeStableAnalysis([1000, 20000, 500000])],
  ];

  it.each(builders)('khung %s: id không trùng và detection xếp từ trái sang phải', (_name, build) => {
    const a = build();
    const ids = a.detections.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const xs = a.detections.map((d) => center(d.bbox).x);
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
  });
});

describe('FakeSpeech', () => {
  it('replayLast nói REPLAY_EMPTY khi chưa có kết quả', () => {
    const speech = new FakeSpeech();
    speech.replayLast();
    expect(speech.lastIntent).toEqual({ kind: 'REPLAY_EMPTY' });
  });

  it('replayLast nói lại kết quả gần nhất', () => {
    const speech = new FakeSpeech();
    const result = {
      status: 'CONFIDENT_SINGLE' as const,
      count: 1,
      denominations: [20000 as const],
      total: 20000,
      formattedTotal: '20.000 đồng',
      timestamp: 0,
    };
    speech.say({ kind: 'RESULT', result });
    speech.replayLast();
    expect(speech.lastIntent).toEqual({ kind: 'REPLAY', result });
    expect(speech.ofKind('RESULT')).toHaveLength(1);
  });

  it('mô phỏng sự kiện utterance start rồi end', () => {
    const speech = new FakeSpeech();
    const events: UtteranceEvent[] = [];
    speech.onUtterance((e) => events.push(e));
    speech.say({ kind: 'WELCOME' });
    expect(speech.isSpeaking).toBe(true);
    expect(speech.finishCurrent()).toBe(true);
    expect(events).toEqual([
      { phase: 'start', kind: 'WELCOME' },
      { phase: 'end', kind: 'WELCOME' },
    ]);
    expect(speech.isSpeaking).toBe(false);
  });

  it('autoStart tắt thì say không phát sự kiện', () => {
    const speech = new FakeSpeech({ autoStart: false });
    const handler = vi.fn();
    speech.onUtterance(handler);
    speech.say({ kind: 'CAMERA_READY' });
    expect(handler).not.toHaveBeenCalled();
    expect(speech.intents).toHaveLength(1);
  });

  it('cancelAll dừng nói và được đếm', () => {
    const speech = new FakeSpeech();
    speech.say({ kind: 'WELCOME' });
    speech.cancelAll();
    expect(speech.isSpeaking).toBe(false);
    expect(speech.cancelCalls).toBe(1);
  });
});

describe('FakeHaptics', () => {
  it('ghi lại sự kiện rung và xóa được', () => {
    const haptics = new FakeHaptics();
    haptics.play('START');
    haptics.play('SUCCESS');
    expect(haptics.events).toEqual(['START', 'SUCCESS']);
    haptics.clear();
    expect(haptics.events).toEqual([]);
  });
});

describe('MemorySettingsStore', () => {
  it('load trả mặc định cộng giá trị khởi tạo', async () => {
    const store = new MemorySettingsStore({ speechRate: 1.2 });
    const settings = await store.load();
    expect(settings.speechRate).toBe(1.2);
    expect(settings.voiceEnabled).toBe(DEFAULT_SETTINGS.voiceEnabled);
  });

  it('save trộn bản vá và trả bản sao', async () => {
    const store = new MemorySettingsStore();
    const saved = await store.save({ verbosity: 'BRIEF' });
    saved.verbosity = 'DETAILED';
    expect(store.snapshot.verbosity).toBe('BRIEF');
  });

  it('reset quay về mặc định', async () => {
    const store = new MemorySettingsStore();
    await store.save({ speechRate: 0.8 });
    expect((await store.reset()).speechRate).toBe(DEFAULT_SETTINGS.speechRate);
  });

  it('failWith làm load, save, reset ném lỗi', async () => {
    const store = new MemorySettingsStore();
    store.failWith = new AppError('STORAGE_FAILED', 'không ghi được');
    await expect(store.load()).rejects.toBeInstanceOf(AppError);
    await expect(store.save({})).rejects.toBeInstanceOf(AppError);
    await expect(store.reset()).rejects.toBeInstanceOf(AppError);
  });
});