import { describe, expect, it } from 'vitest';
import type { AppState } from '../../src/contracts';
import { INITIAL_SNAPSHOT, TRANSITIONS, phaseOf, transition } from '../../src/decision/state-manager';
import type { MachineSnapshot, StateTrigger } from '../../src/decision/state-manager';

// Hai bản đồ bắt buộc đủ khóa (thiếu một khóa là lỗi biên dịch): đáp án độc lập với mã nguồn.
const STATE_SET: Record<AppState, true> = {
  INITIALIZING: true, AWAITING_START: true, WAITING_PERMISSION: true, LOADING_MODEL: true, READY: true,
  NO_CANDIDATE: true, DETECTING: true, UNCERTAIN: true, OVERLAPPING: true, STABILIZING: true,
  RESULT_READY: true, SPEAKING: true, ERROR: true,
};
const TRIGGER_SET: Record<StateTrigger, true> = {
  APP_STARTED: true, GESTURE_UNLOCKED: true, PERMISSION_REQUESTED: true, MODEL_READY: true, CAMERA_READY: true,
  RESULT_SPEECH_ENDED: true, APP_BACKGROUNDED: true, APP_FOREGROUNDED: true, FAILURE: true,
  NO_MONEY_SEEN: true, UNCERTAIN_SEEN: true, OVERLAP_SEEN: true, UNSTABLE_SEEN: true, STEADY_SEEN: true, RESULT_PUBLISHED: true,
};
const ALL_STATES = Object.keys(STATE_SET) as AppState[];
const ALL_TRIGGERS = Object.keys(TRIGGER_SET) as StateTrigger[];
const STARTUP: AppState[] = ['INITIALIZING', 'AWAITING_START', 'LOADING_MODEL', 'WAITING_PERMISSION'];
const SCANNING: AppState[] = ['READY', 'NO_CANDIDATE', 'DETECTING', 'UNCERTAIN', 'OVERLAPPING', 'STABILIZING', 'RESULT_READY'];

const ANALYSIS_TARGET: Partial<Record<StateTrigger, AppState>> = {
  NO_MONEY_SEEN: 'NO_CANDIDATE', UNCERTAIN_SEEN: 'UNCERTAIN', OVERLAP_SEEN: 'OVERLAPPING',
  UNSTABLE_SEEN: 'STABILIZING', STEADY_SEEN: 'DETECTING', RESULT_PUBLISHED: 'SPEAKING',
};
/** Sự kiện chỉ hợp lệ ở đúng một trạng thái: [nguồn, đích]. */
const SINGLE_EDGE: Partial<Record<StateTrigger, readonly [AppState, AppState]>> = {
  APP_STARTED: ['INITIALIZING', 'AWAITING_START'], GESTURE_UNLOCKED: ['AWAITING_START', 'LOADING_MODEL'],
  PERMISSION_REQUESTED: ['LOADING_MODEL', 'WAITING_PERMISSION'], RESULT_SPEECH_ENDED: ['SPEAKING', 'DETECTING'],
};

/** Kỳ vọng viết lại bằng QUY TẮC (cờ mặc định tắt nên chưa lên READY). null = chuyển trái phép. */
function expectedNext(state: AppState, trigger: StateTrigger): AppState | null {
  switch (trigger) {
    case 'FAILURE': return 'ERROR';
    case 'APP_BACKGROUNDED': return state;
    case 'APP_FOREGROUNDED': return SCANNING.includes(state) || state === 'SPEAKING' ? 'DETECTING' : state;
    case 'MODEL_READY': return state === 'ERROR' ? null : state;
    case 'CAMERA_READY':
      if (state === 'ERROR') return null;
      return state === 'WAITING_PERMISSION' ? 'LOADING_MODEL' : state;
    case 'APP_STARTED':
    case 'GESTURE_UNLOCKED':
    case 'PERMISSION_REQUESTED':
    case 'RESULT_SPEECH_ENDED': {
      const edge = SINGLE_EDGE[trigger];
      return edge !== undefined && edge[0] === state ? edge[1] : null;
    }
    default: return SCANNING.includes(state) ? (ANALYSIS_TARGET[trigger] ?? null) : null;
  }
}

const at = (state: AppState): MachineSnapshot => ({ ...INITIAL_SNAPSHOT, state });
const run = (triggers: StateTrigger[]): MachineSnapshot =>
  triggers.reduce<MachineSnapshot>((snap, trigger) => transition(snap, trigger).snapshot, INITIAL_SNAPSHOT);

describe('bảng chuyển trạng thái', () => {
  it('có đúng 13 hàng của hợp đồng', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
  });

  describe.each(ALL_STATES)('từ %s', (state) => {
    it.each(ALL_TRIGGERS)('%s', (trigger) => {
      const result = transition(at(state), trigger);
      const expected = expectedNext(state, trigger);
      expect(result.accepted).toBe(expected !== null);
      expect(result.to).toBe(expected ?? state);
      expect(result.snapshot.state).toBe(result.to);
    });
  });

  it('chuyển trái phép giữ nguyên ảnh chụp và ghi lý do; chuyển hợp lệ không có lý do trái phép', () => {
    const before = at('INITIALIZING');
    const illegal = transition(before, 'GESTURE_UNLOCKED');
    expect(illegal.snapshot).toBe(before);
    expect(illegal.reasons).toEqual(['ILLEGAL_TRANSITION', 'GESTURE_UNLOCKED@INITIALIZING']);
    expect(transition(before, 'APP_STARTED').reasons).toEqual([]);
  });

  it('không sửa ảnh chụp đầu vào', () => {
    const frozen = Object.freeze(at('LOADING_MODEL'));
    expect(() => transition(frozen, 'MODEL_READY')).not.toThrow();
  });
});

describe('giai đoạn', () => {
  it.each([
    ...STARTUP.map((state) => ({ state, phase: 'STARTUP' })),
    ...SCANNING.map((state) => ({ state, phase: 'SCANNING' })),
    { state: 'SPEAKING' as AppState, phase: 'SPEAKING' },
    { state: 'ERROR' as AppState, phase: 'ERROR' },
  ])('$state → $phase', ({ state, phase }) => {
    expect(phaseOf(state)).toBe(phase);
  });
});

describe('khởi động: thứ tự sự kiện', () => {
  const GATE: StateTrigger[] = ['APP_STARTED', 'GESTURE_UNLOCKED'];

  it.each<{ name: string; events: StateTrigger[]; beforeLast: AppState }>([
    { name: 'xin quyền, model rồi camera', events: ['PERMISSION_REQUESTED', 'MODEL_READY', 'CAMERA_READY'], beforeLast: 'WAITING_PERMISSION' },
    { name: 'xin quyền, camera rồi model', events: ['PERMISSION_REQUESTED', 'CAMERA_READY', 'MODEL_READY'], beforeLast: 'LOADING_MODEL' },
    { name: 'quyền cấp sẵn, model rồi camera', events: ['MODEL_READY', 'CAMERA_READY'], beforeLast: 'LOADING_MODEL' },
    { name: 'quyền cấp sẵn, camera rồi model', events: ['CAMERA_READY', 'MODEL_READY'], beforeLast: 'LOADING_MODEL' },
    { name: 'model xong trước khi xin quyền', events: ['MODEL_READY', 'PERMISSION_REQUESTED', 'CAMERA_READY'], beforeLast: 'WAITING_PERMISSION' },
  ])('$name: chỉ READY khi đủ cả hai', ({ events, beforeLast }) => {
    expect(run([...GATE, ...events.slice(0, -1)]).state).toBe(beforeLast);
    expect(run([...GATE, ...events]).state).toBe('READY');
  });

  it('camera đã sẵn sàng thì PERMISSION_REQUESTED muộn bị bỏ qua', () => {
    const snap = run([...GATE, 'CAMERA_READY']);
    expect(transition(snap, 'PERMISSION_REQUESTED').accepted).toBe(false);
    expect(transition(snap, 'MODEL_READY').to).toBe('READY');
  });

  it('PERMISSION_REQUESTED lặp lại khi đang chờ quyền bị bỏ qua', () => {
    expect(transition(run([...GATE, 'PERMISSION_REQUESTED']), 'PERMISSION_REQUESTED').accepted).toBe(false);
  });

  it('cờ đến sớm được ghi nhận nhưng chỉ lên READY sau GESTURE_UNLOCKED', () => {
    expect(run(['MODEL_READY', 'CAMERA_READY', 'APP_STARTED'])).toMatchObject({ state: 'AWAITING_START', modelReady: true, cameraReady: true });
    expect(run(['MODEL_READY', 'CAMERA_READY', 'APP_STARTED', 'GESTURE_UNLOCKED']).state).toBe('READY');
  });
});

describe('nền và trở lại', () => {
  it('APP_BACKGROUNDED bật cờ, APP_FOREGROUNDED tắt cờ', () => {
    expect(run(['APP_BACKGROUNDED']).backgrounded).toBe(true);
    expect(run(['APP_BACKGROUNDED', 'APP_FOREGROUNDED']).backgrounded).toBe(false);
  });
});