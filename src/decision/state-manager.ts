import type { AppState, SystemEvent } from '../contracts';

/** Nguyên nhân chuyển trạng thái đến từ kết quả phân tích khung hình (nhánh ANALYSIS dùng ở lượt 2). */
export type AnalysisTrigger =
  | 'NO_MONEY_SEEN'      // khung không có tiền → NO_CANDIDATE
  | 'UNCERTAIN_SEEN'     // chưa chắc, xung đột hoặc bị chặn → UNCERTAIN
  | 'OVERLAP_SEEN'       // chồng lấn → OVERLAPPING
  | 'UNSTABLE_SEEN'      // chắc nhưng chưa ổn định → STABILIZING
  | 'STEADY_SEEN'        // ổn định, đã công bố, không có gì mới → DETECTING
  | 'RESULT_PUBLISHED';  // công bố kết quả mới → SPEAKING

/** Mọi nguyên nhân có thể làm đổi trạng thái. */
export type StateTrigger = SystemEvent | 'FAILURE' | AnalysisTrigger;

/** Giai đoạn: khởi động, đang quét, đang đọc kết quả, lỗi. */
export type Phase = 'STARTUP' | 'SCANNING' | 'SPEAKING' | 'ERROR';

/** Ảnh chụp bất biến của máy. Hai cờ model/camera được ghi ở mọi trạng thái khởi động để không mất sự kiện đến sớm. */
export interface MachineSnapshot {
  readonly state: AppState;
  readonly modelReady: boolean;
  readonly cameraReady: boolean;
  readonly backgrounded: boolean;
}

export interface TransitionResult {
  /** false = chuyển trái phép, bị bỏ qua. */
  readonly accepted: boolean;
  readonly from: AppState;
  /** Bằng `from` khi bị bỏ qua hoặc không đổi. */
  readonly to: AppState;
  /** Ảnh chụp SAU khi áp dụng (chính ảnh đầu vào khi bị bỏ qua). */
  readonly snapshot: MachineSnapshot;
  /** [] khi hợp lệ; ['ILLEGAL_TRANSITION', 'NGUYÊN_NHÂN@TRẠNG_THÁI'] khi bị bỏ qua. */
  readonly reasons: readonly string[];
}

export const INITIAL_SNAPSHOT: MachineSnapshot = Object.freeze({
  state: 'INITIALIZING',
  modelReady: false,
  cameraReady: false,
  backgrounded: false,
});

type Row = Readonly<Partial<Record<StateTrigger, AppState>>>;

/** Hàng chung của mọi trạng thái đang quét; trở lại từ nền thì về DETECTING. */
function scanningRow(self: AppState): Row {
  return {
    NO_MONEY_SEEN: 'NO_CANDIDATE', UNCERTAIN_SEEN: 'UNCERTAIN', OVERLAP_SEEN: 'OVERLAPPING',
    UNSTABLE_SEEN: 'STABILIZING', STEADY_SEEN: 'DETECTING', RESULT_PUBLISHED: 'SPEAKING',
    MODEL_READY: self, CAMERA_READY: self, APP_BACKGROUNDED: self, APP_FOREGROUNDED: 'DETECTING', FAILURE: 'ERROR',
  };
}

/** Hàng của trạng thái khởi động: ghi cờ và nền/trở lại giữ nguyên; `own` thêm hoặc đè các cạnh riêng. */
function startupRow(self: AppState, own: Row): Row {
  return { MODEL_READY: self, CAMERA_READY: self, APP_BACKGROUNDED: self, APP_FOREGROUNDED: self, FAILURE: 'ERROR', ...own };
}

/**
 * Bảng chuyển: TRANSITIONS[trạng thái hiện tại][nguyên nhân] = trạng thái kế tiếp; ô vắng = trái phép.
 * RESULT_READY là trạng thái dành riêng: engine công bố kết quả đi thẳng sang SPEAKING nên không dừng ở đó.
 * Hai quy tắc phụ nằm trong `transition`.
 */
export const TRANSITIONS: Readonly<Record<AppState, Row>> = {
  INITIALIZING: startupRow('INITIALIZING', { APP_STARTED: 'AWAITING_START' }),
  AWAITING_START: startupRow('AWAITING_START', { GESTURE_UNLOCKED: 'LOADING_MODEL' }),
  LOADING_MODEL: startupRow('LOADING_MODEL', { PERMISSION_REQUESTED: 'WAITING_PERMISSION' }),
  WAITING_PERMISSION: startupRow('WAITING_PERMISSION', { CAMERA_READY: 'LOADING_MODEL' }),
  READY: scanningRow('READY'),
  NO_CANDIDATE: scanningRow('NO_CANDIDATE'),
  DETECTING: scanningRow('DETECTING'),
  UNCERTAIN: scanningRow('UNCERTAIN'),
  OVERLAPPING: scanningRow('OVERLAPPING'),
  STABILIZING: scanningRow('STABILIZING'),
  RESULT_READY: scanningRow('RESULT_READY'),
  SPEAKING: {
    RESULT_SPEECH_ENDED: 'DETECTING', MODEL_READY: 'SPEAKING', CAMERA_READY: 'SPEAKING',
    APP_BACKGROUNDED: 'SPEAKING', APP_FOREGROUNDED: 'DETECTING', FAILURE: 'ERROR',
  },
  ERROR: { APP_BACKGROUNDED: 'ERROR', APP_FOREGROUNDED: 'ERROR', FAILURE: 'ERROR' },
};

/** Giai đoạn của một trạng thái, suy ra từ bảng: trạng thái nhận kết quả phân tích là đang quét. */
export function phaseOf(state: AppState): Phase {
  if (state === 'ERROR' || state === 'SPEAKING') return state;
  return TRANSITIONS[state].STEADY_SEEN === undefined ? 'STARTUP' : 'SCANNING';
}

/**
 * Áp dụng một nguyên nhân lên ảnh chụp hiện tại (hàm thuần, không sửa đầu vào). Ngoài bảng có hai quy tắc:
 * 1. PERMISSION_REQUESTED bị bỏ qua khi camera đã sẵn sàng (quyền đã xong, không xin lại).
 * 2. Nếu đích là LOADING_MODEL hoặc WAITING_PERMISSION mà đã đủ MODEL_READY và CAMERA_READY thì đích là READY.
 *    Cờ được ghi từ mọi trạng thái khởi động, nhưng READY chỉ đạt được sau GESTURE_UNLOCKED
 *    (chưa có thao tác chạm thì chưa nói được).
 */
export function transition(current: MachineSnapshot, trigger: StateTrigger): TransitionResult {
  const target = TRANSITIONS[current.state][trigger];
  if (target === undefined || (trigger === 'PERMISSION_REQUESTED' && current.cameraReady)) {
    return {
      accepted: false,
      from: current.state,
      to: current.state,
      snapshot: current,
      reasons: ['ILLEGAL_TRANSITION', `${trigger}@${current.state}`],
    };
  }
  const modelReady = current.modelReady || trigger === 'MODEL_READY';
  const cameraReady = current.cameraReady || trigger === 'CAMERA_READY';
  const backgrounded = trigger === 'APP_BACKGROUNDED' ? true : trigger === 'APP_FOREGROUNDED' ? false : current.backgrounded;
  const waiting = target === 'LOADING_MODEL' || target === 'WAITING_PERMISSION';
  const to: AppState = waiting && modelReady && cameraReady ? 'READY' : target;
  return { accepted: true, from: current.state, to, snapshot: { state: to, modelReady, cameraReady, backgrounded }, reasons: [] };
}