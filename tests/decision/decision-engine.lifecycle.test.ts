// Lượt 1: vòng đời (khởi động, FAILURE, USER_REPLAY, nền/trở lại, cổng chặn ANALYSIS).
// Ca USER_REPLAY CÓ kết quả và các nhánh ANALYSIS 1..7 được kiểm ở lượt 2 (cần engine sinh được kết quả).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import type { AppErrorCode, AppState, DecisionInput, DecisionOutput, IDecisionEngine, SpeechIntent, SystemEvent } from '../../src/contracts';
import { createDecisionEngine } from '../../src/decision/decision-engine';
import { TRANSITIONS } from '../../src/decision/state-manager';
import { mulberry32 } from '../../src/utils/math';
import { makeAnalysis } from '../fakes/factories';

const sys = (event: SystemEvent, now = 0): DecisionInput => ({ type: 'SYSTEM', event, now });
const fail = (code: AppErrorCode, now = 0): DecisionInput => ({ type: 'FAILURE', code, now });
const replay = (now = 0): DecisionInput => ({ type: 'USER_REPLAY', now });
const analyze = (now = 0): DecisionInput => ({ type: 'ANALYSIS', analysis: makeAnalysis(), now });
const newEngine = (): IDecisionEngine => createDecisionEngine(DEFAULT_CONFIG.decision);

type Startup = 'INITIALIZING' | 'AWAITING_START' | 'LOADING_MODEL' | 'WAITING_PERMISSION' | 'READY';
/** Chuỗi sự kiện đưa engine mới tới từng trạng thái khởi động. */
const PATH: Record<Startup, SystemEvent[]> = {
  INITIALIZING: [],
  AWAITING_START: ['APP_STARTED'],
  LOADING_MODEL: ['APP_STARTED', 'GESTURE_UNLOCKED'],
  WAITING_PERMISSION: ['APP_STARTED', 'GESTURE_UNLOCKED', 'PERMISSION_REQUESTED'],
  READY: ['APP_STARTED', 'GESTURE_UNLOCKED', 'PERMISSION_REQUESTED', 'MODEL_READY', 'CAMERA_READY'],
};
const STARTUP = Object.keys(PATH) as Startup[];
const SYSTEM_EVENTS: SystemEvent[] = [
  'APP_STARTED', 'GESTURE_UNLOCKED', 'PERMISSION_REQUESTED', 'MODEL_READY', 'CAMERA_READY',
  'RESULT_SPEECH_ENDED', 'APP_BACKGROUNDED', 'APP_FOREGROUNDED',
];
const ERROR_CODES: AppErrorCode[] = [
  'UNSUPPORTED_BROWSER', 'CAMERA_PERMISSION_DENIED', 'CAMERA_NOT_FOUND', 'CAMERA_IN_USE', 'CAMERA_FAILED',
  'MODEL_MISSING', 'MODEL_CORRUPT', 'MODEL_INIT_FAILED', 'INFERENCE_FAILED',
  'TTS_UNAVAILABLE', 'TTS_NO_VIETNAMESE_VOICE', 'STORAGE_FAILED', 'OFFLINE_NOT_READY',
];

function drive(events: SystemEvent[]): IDecisionEngine {
  const engine = newEngine();
  for (const event of events) engine.handle(sys(event));
  return engine;
}

/** Đầu ra không công bố kết quả: result null và không được tính tổng. */
function expectNoResult(out: DecisionOutput): void {
  expect(out.result).toBeNull();
  expect(out.shouldCalculateTotal).toBe(false);
}

describe('khởi động theo sự kiện hệ thống', () => {
  it('ban đầu ở INITIALIZING và chưa có kết quả', () => {
    const engine = newEngine();
    expect(engine.state).toBe('INITIALIZING');
    expect(engine.lastResult).toBeNull();
  });

  it('đi đúng chuỗi trạng thái, lời nói và mã lý do', () => {
    const steps: Array<{ event: SystemEvent; state: AppState; speech: SpeechIntent['kind'] | null; reasons: string[] }> = [
      { event: 'APP_STARTED', state: 'AWAITING_START', speech: 'WELCOME', reasons: ['APP_STARTED'] },
      { event: 'GESTURE_UNLOCKED', state: 'LOADING_MODEL', speech: null, reasons: ['GESTURE_UNLOCKED'] },
      { event: 'PERMISSION_REQUESTED', state: 'WAITING_PERMISSION', speech: 'PERMISSION_PRIMER', reasons: ['PERMISSION_REQUESTED'] },
      { event: 'MODEL_READY', state: 'WAITING_PERMISSION', speech: null, reasons: ['MODEL_READY', 'WAIT_CAMERA'] },
      { event: 'CAMERA_READY', state: 'READY', speech: 'CAMERA_READY', reasons: ['CAMERA_READY', 'BOTH_READY'] },
    ];
    const engine = newEngine();
    for (const step of steps) {
      const out = engine.handle(sys(step.event));
      expect([out.state, out.speech?.kind ?? null, out.reasons], step.event).toEqual([step.state, step.speech, step.reasons]);
      expect(engine.state, step.event).toBe(step.state);
      expect(out.status, step.event).toBeNull();
      expectNoResult(out);
    }
  });

  it('camera xong trước model: chờ model rồi mới READY', () => {
    const engine = drive(PATH.WAITING_PERMISSION);
    const camera = engine.handle(sys('CAMERA_READY'));
    expect([camera.state, camera.speech, camera.reasons]).toEqual(['LOADING_MODEL', null, ['CAMERA_READY', 'WAIT_MODEL']]);
    const model = engine.handle(sys('MODEL_READY'));
    expect([model.state, model.speech]).toEqual(['READY', { kind: 'CAMERA_READY' }]);
  });

  it('model và camera đến trước cử chỉ: chỉ READY sau GESTURE_UNLOCKED', () => {
    const engine = drive(PATH.AWAITING_START);
    for (const event of ['MODEL_READY', 'CAMERA_READY'] as const) {
      const out = engine.handle(sys(event));
      expect([out.state, out.speech]).toEqual(['AWAITING_START', null]);
    }
    const gesture = engine.handle(sys('GESTURE_UNLOCKED'));
    expect([gesture.state, gesture.speech, gesture.reasons]).toEqual(['READY', { kind: 'CAMERA_READY' }, ['GESTURE_UNLOCKED', 'BOTH_READY']]);
  });

  it('MODEL_READY và CAMERA_READY lặp lại khi đã READY thì im lặng, không đọc lại', () => {
    const engine = drive(PATH.READY);
    for (const event of ['MODEL_READY', 'CAMERA_READY'] as const) {
      const out = engine.handle(sys(event));
      expect([out.state, out.speech, out.reasons]).toEqual(['READY', null, [event]]);
    }
  });
});

describe('chuyển trái phép bị bỏ qua, không ném lỗi', () => {
  it.each<{ name: string; at: Startup; event: SystemEvent }>([
    { name: 'GESTURE_UNLOCKED khi chưa APP_STARTED', at: 'INITIALIZING', event: 'GESTURE_UNLOCKED' },
    { name: 'PERMISSION_REQUESTED trước cử chỉ', at: 'AWAITING_START', event: 'PERMISSION_REQUESTED' },
    { name: 'APP_STARTED lặp lại', at: 'AWAITING_START', event: 'APP_STARTED' },
    { name: 'PERMISSION_REQUESTED lặp lại', at: 'WAITING_PERMISSION', event: 'PERMISSION_REQUESTED' },
    { name: 'RESULT_SPEECH_ENDED khi không đọc gì', at: 'READY', event: 'RESULT_SPEECH_ENDED' },
  ])('$name', ({ at, event }) => {
    const engine = drive(PATH[at]);
    const out = engine.handle(sys(event));
    expect([out.state, engine.state, out.speech]).toEqual([at, at, null]);
    expect(out.reasons).toEqual(['ILLEGAL_TRANSITION', `${event}@${at}`]);
    expectNoResult(out);
  });

  it('đầu vào hỏng (loại lạ, sự kiện lạ) không làm engine ném lỗi hay đổi trạng thái', () => {
    const engine = drive(PATH.AWAITING_START);
    expect(engine.handle({ type: 'NOPE', now: 0 } as unknown as DecisionInput).reasons).toEqual(['UNKNOWN_INPUT']);
    expect(engine.handle(sys('NOPE' as SystemEvent)).reasons).toEqual(['ILLEGAL_TRANSITION', 'NOPE@AWAITING_START']);
    expect(engine.state).toBe('AWAITING_START');
  });
});

describe('FAILURE: ưu tiên cao nhất', () => {
  it.each(STARTUP)('từ %s → ERROR kèm lời báo lỗi', (from) => {
    const engine = drive(PATH[from]);
    const out = engine.handle(fail('CAMERA_PERMISSION_DENIED'));
    expect([out.state, engine.state]).toEqual(['ERROR', 'ERROR']);
    expect(out.speech).toEqual({ kind: 'ERROR', code: 'CAMERA_PERMISSION_DENIED' });
    expect(out.reasons).toEqual(['FAILURE', 'CAMERA_PERMISSION_DENIED']);
    expectNoResult(out);
  });

  it('mọi mã lỗi đều được đọc đúng mã', () => {
    for (const code of ERROR_CODES) expect(newEngine().handle(fail(code)).speech).toEqual({ kind: 'ERROR', code });
  });

  it('vẫn được xử lý khi app đang ở nền', () => {
    const out = drive([...PATH.READY, 'APP_BACKGROUNDED']).handle(fail('CAMERA_FAILED'));
    expect([out.state, out.speech]).toEqual(['ERROR', { kind: 'ERROR', code: 'CAMERA_FAILED' }]);
  });

  it('lỗi trùng mã khi đã ở ERROR thì im lặng, lỗi khác mã thì đọc mã mới', () => {
    const engine = drive(PATH.READY);
    engine.handle(fail('CAMERA_FAILED'));
    const same = engine.handle(fail('CAMERA_FAILED'));
    expect([same.state, same.speech, same.reasons]).toEqual(['ERROR', null, ['FAILURE', 'CAMERA_FAILED', 'DUPLICATE']]);
    expect(engine.handle(fail('MODEL_INIT_FAILED')).speech).toEqual({ kind: 'ERROR', code: 'MODEL_INIT_FAILED' });
  });

  it.each(SYSTEM_EVENTS.filter((e) => e !== 'APP_BACKGROUNDED' && e !== 'APP_FOREGROUNDED'))('ERROR khóa: %s bị bỏ qua', (event) => {
    const engine = drive(PATH.READY);
    engine.handle(fail('CAMERA_FAILED'));
    const out = engine.handle(sys(event));
    expect([out.state, out.speech, out.reasons]).toEqual(['ERROR', null, ['ILLEGAL_TRANSITION', `${event}@ERROR`]]);
  });

  it('ERROR khóa: phân tích khung hình bị bỏ qua', () => {
    const engine = drive(PATH.READY);
    engine.handle(fail('CAMERA_FAILED'));
    const out = engine.handle(analyze());
    expect([out.reasons, out.speech]).toEqual([['ANALYSIS_IGNORED', 'ERROR_STATE'], null]);
    expectNoResult(out);
  });

  it('reset() thoát ERROR: khởi động lại từ đầu và cùng lỗi được đọc lại', () => {
    const engine = drive(PATH.READY);
    engine.handle(fail('CAMERA_FAILED'));
    engine.reset();
    expect(engine.state).toBe('INITIALIZING');
    expect(engine.handle(sys('APP_STARTED')).speech).toEqual({ kind: 'WELCOME' });
    expect(engine.handle(fail('CAMERA_FAILED')).speech).toEqual({ kind: 'ERROR', code: 'CAMERA_FAILED' });
  });
});

describe('USER_REPLAY khi chưa có kết quả', () => {
  it.each<Startup | 'ERROR'>([...STARTUP, 'ERROR'])('ở %s: đọc REPLAY_EMPTY, không đổi trạng thái', (at) => {
    const engine = drive(at === 'ERROR' ? PATH.READY : PATH[at]);
    if (at === 'ERROR') engine.handle(fail('CAMERA_FAILED'));
    const out = engine.handle(replay());
    expect([out.state, engine.state, out.speech, out.reasons]).toEqual([at, at, { kind: 'REPLAY_EMPTY' }, ['USER_REPLAY', 'NO_RESULT']]);
    expect(out.status).toBeNull();
    expectNoResult(out);
    expect(engine.lastResult).toBeNull();
  });

  it('không đổi logic quét: xen USER_REPLAY vào giữa không làm đổi các đầu ra khác', () => {
    const plain = newEngine();
    const withReplay = newEngine();
    for (const event of PATH.READY) {
      withReplay.handle(replay());
      expect(withReplay.handle(sys(event))).toEqual(plain.handle(sys(event)));
    }
  });
});

describe('nền và trở lại', () => {
  it('APP_BACKGROUNDED giữ trạng thái; phân tích bị bỏ qua cho tới khi trở lại', () => {
    const engine = drive(PATH.READY);
    const bg = engine.handle(sys('APP_BACKGROUNDED'));
    expect([bg.state, bg.reasons, bg.speech]).toEqual(['READY', ['APP_BACKGROUNDED'], null]);
    const ignored = engine.handle(analyze());
    expect([ignored.state, ignored.reasons, ignored.speech]).toEqual(['READY', ['ANALYSIS_IGNORED', 'BACKGROUNDED'], null]);
    expectNoResult(ignored);
  });

  it('APP_FOREGROUNDED xóa bộ nhớ ngắn hạn, về DETECTING và hết bỏ qua phân tích', () => {
    const engine = drive([...PATH.READY, 'APP_BACKGROUNDED']);
    const fg = engine.handle(sys('APP_FOREGROUNDED'));
    expect([fg.state, fg.reasons, fg.speech]).toEqual(['DETECTING', ['APP_FOREGROUNDED', 'MEMORY_CLEARED'], null]);
    expect(engine.handle(analyze()).reasons).not.toContain('BACKGROUNDED');
  });

  it('trở lại khi đang khởi động hoặc đang lỗi thì giữ nguyên trạng thái', () => {
    expect(drive([...PATH.LOADING_MODEL, 'APP_BACKGROUNDED']).handle(sys('APP_FOREGROUNDED')).state).toBe('LOADING_MODEL');
    const broken = drive(PATH.READY);
    broken.handle(fail('CAMERA_FAILED'));
    expect(broken.handle(sys('APP_FOREGROUNDED')).state).toBe('ERROR');
  });
});

describe('phân tích khi chưa sẵn sàng', () => {
  it.each(STARTUP.filter((s) => s !== 'READY'))('ở %s: bỏ qua, không nói, không có kết quả', (at) => {
    const out = drive(PATH[at]).handle(analyze());
    expect([out.state, out.reasons, out.speech]).toEqual([at, ['ANALYSIS_IGNORED', 'NOT_READY'], null]);
    expectNoResult(out);
  });
});

type Op = DecisionInput | 'RESET';

/** Dãy thao tác ngẫu nhiên (đầu vào hoặc reset) dựng từ một seed. */
function buildOps(seed: number, length: number): Op[] {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[], fallback: T): T => items[Math.floor(random() * items.length)] ?? fallback;
  return Array.from({ length }, (_, i): Op => {
    const roll = random();
    if (roll < 0.03) return 'RESET';
    if (roll < 0.06) return fail(pick(ERROR_CODES, 'CAMERA_FAILED'), i * 100);
    if (roll < 0.16) return replay(i * 100);
    if (roll < 0.3) return analyze(i * 100);
    return sys(pick(SYSTEM_EVENTS, 'APP_STARTED'), i * 100);
  });
}

function play(ops: Op[]): Array<{ input: DecisionInput; out: DecisionOutput }> {
  const engine = newEngine();
  const log: Array<{ input: DecisionInput; out: DecisionOutput }> = [];
  for (const op of ops) {
    if (op === 'RESET') engine.reset();
    else log.push({ input: op, out: engine.handle(op) });
  }
  return log;
}

describe('chuỗi đầu vào ngẫu nhiên (4000 thao tác)', () => {
  const ops = buildOps(20241114, 4000);
  const log = play(ops);

  afterEach(() => vi.restoreAllMocks());

  it('cùng chuỗi đầu vào cho cùng chuỗi đầu ra', () => {
    expect(play(ops)).toEqual(log);
  });

  it('không đọc đồng hồ hệ thống (Date.now, performance.now)', () => {
    const dateNow = vi.spyOn(Date, 'now');
    const perfNow = vi.spyOn(performance, 'now');
    play(ops);
    expect(dateNow).not.toHaveBeenCalled();
    expect(perfNow).not.toHaveBeenCalled();
  });

  it('mọi đầu ra có state hợp lệ và reasons là mảng mã không rỗng', () => {
    for (const { out } of log) {
      expect(Object.keys(TRANSITIONS)).toContain(out.state);
      expect(out.reasons.length).toBeGreaterThan(0);
      expect(out.reasons.every((r) => r.length > 0)).toBe(true);
    }
  });

  it('đầu vào không phải ANALYSIS không bao giờ có status hay kết quả', () => {
    for (const { input, out } of log) {
      if (input.type === 'ANALYSIS') continue;
      expect(out.status).toBeNull();
      expectNoResult(out);
    }
  });

  it('với khung không có tiền, engine không bao giờ công bố kết quả hay tính tổng', () => {
    for (const { out } of log) expectNoResult(out);
  });

  it('dãy ngẫu nhiên đi qua đủ các trạng thái khởi động và ERROR (không phải kiểm thử rỗng)', () => {
    const visited = new Set<AppState>(log.map(({ out }) => out.state));
    for (const state of [...STARTUP, 'ERROR'] as const) expect(visited.has(state), state).toBe(true);
  });
});