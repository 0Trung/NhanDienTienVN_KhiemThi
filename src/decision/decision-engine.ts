// STUB P07 (lượt 1/2) — nhánh ANALYSIS chưa cài; lượt 2 sẽ ghi đè file này.
import type {
  AppConfig, AppErrorCode, DecisionInput, DecisionOutput, GuidanceCode, IDecisionEngine,
  RecognitionResult, SpeechIntent, SystemEvent,
} from '../contracts';
import { INITIAL_SNAPSHOT, phaseOf, transition } from './state-manager';
import type { StateTrigger, TransitionResult } from './state-manager';

/** Bộ nhớ ngắn hạn của việc quét (nhánh ANALYSIS dùng ở lượt 2). Xóa khi APP_FOREGROUNDED và reset(). */
interface ShortTermMemory {
  /** Chữ ký (mệnh giá từ trái sang phải) của kết quả đã công bố; null = chưa có hoặc tiền đã rời khung. */
  announcedSignature: string | null;
  /** `now` của khung đầu chuỗi khung trống hiện tại; null = đang không trống. */
  emptySince: number | null;
  /** `now` của khung đầu chuỗi khung chưa ổn định hiện tại; null = đang ổn định. */
  unstableSince: number | null;
  /** `now` lần cuối phát mỗi mã guidance (cooldown tính riêng theo từng mã). */
  guidanceAt: Partial<Record<GuidanceCode, number>>;
}

const freshMemory = (): ShortTermMemory => ({ announcedSignature: null, emptySince: null, unstableSince: null, guidanceAt: {} });

/** Sao chép để module khác không sửa nhầm bản engine giữ: đọc lại phải y hệt lần đã đọc. */
const cloneResult = (r: RecognitionResult): RecognitionResult => ({ ...r, denominations: [...r.denominations] });

/** Lời nói khi VÀO một trạng thái khởi động mới; null nếu trạng thái không đổi hoặc không có lời. */
function entrySpeech(t: TransitionResult): SpeechIntent | null {
  if (t.from === t.to) return null;
  if (t.to === 'AWAITING_START') return { kind: 'WELCOME' };
  if (t.to === 'WAITING_PERMISSION') return { kind: 'PERMISSION_PRIMER' };
  if (t.to === 'READY') return { kind: 'CAMERA_READY' };
  return null;
}

/**
 * DecisionEngine (Module 6). XÁC ĐỊNH: cùng chuỗi đầu vào cho cùng chuỗi đầu ra; không đồng hồ, không DOM,
 * không I/O; thời gian chỉ đến từ trường `now` của đầu vào.
 *
 * Mã lý do (`reasons`): SYSTEM hợp lệ = [tên sự kiện, ...BOTH_READY | WAIT_CAMERA | WAIT_MODEL | MEMORY_CLEARED];
 * trái phép = ['ILLEGAL_TRANSITION', 'SỰ_KIỆN@TRẠNG_THÁI']; FAILURE = ['FAILURE', mã lỗi, ...DUPLICATE];
 * USER_REPLAY = ['USER_REPLAY', 'HAS_RESULT' | 'NO_RESULT']; ANALYSIS bị bỏ qua =
 * ['ANALYSIS_IGNORED', 'ERROR_STATE' | 'NOT_READY' | 'BACKGROUNDED'].
 *
 * ERROR là trạng thái cuối: mọi FAILURE dẫn tới đó; thoát bằng reset() rồi APP_STARTED.
 * Lượt 1 chỉ cài vòng đời: mọi đầu ra đều có result = null và shouldCalculateTotal = false.
 */
export function createDecisionEngine(config: AppConfig['decision']): IDecisionEngine {
  // `config` dùng ở lượt 2: mọi ngưỡng của nhánh ANALYSIS lấy từ đây.
  let snapshot = INITIAL_SNAPSHOT;
  let lastResult: RecognitionResult | null = null;
  let memory = freshMemory();
  let errorCode: AppErrorCode | null = null;

  function apply(trigger: StateTrigger): TransitionResult {
    const t = transition(snapshot, trigger);
    snapshot = t.snapshot;
    return t;
  }

  /** Đầu ra không công bố kết quả: status null, result null, shouldCalculateTotal false. */
  function outputOf(reasons: string[], speech: SpeechIntent | null = null): DecisionOutput {
    return { state: snapshot.state, status: null, reasons, speech, result: null, shouldCalculateTotal: false };
  }

  function systemReasons(event: SystemEvent, t: TransitionResult): string[] {
    const reasons: string[] = [event];
    if (t.to === 'READY' && t.from !== 'READY') {
      reasons.push('BOTH_READY');
    } else if ((event === 'MODEL_READY' || event === 'CAMERA_READY') && phaseOf(t.to) === 'STARTUP') {
      if (!snapshot.cameraReady) reasons.push('WAIT_CAMERA');
      if (!snapshot.modelReady) reasons.push('WAIT_MODEL');
    }
    if (event === 'APP_FOREGROUNDED') reasons.push('MEMORY_CLEARED');
    return reasons;
  }

  function onSystem(event: SystemEvent): DecisionOutput {
    const t = apply(event);
    if (!t.accepted) return outputOf([...t.reasons]);
    if (event === 'APP_FOREGROUNDED') memory = freshMemory();
    return outputOf(systemReasons(event, t), entrySpeech(t));
  }

  function onFailure(code: AppErrorCode): DecisionOutput {
    apply('FAILURE'); // hợp lệ ở mọi trạng thái: ưu tiên cao nhất
    if (errorCode === code) return outputOf(['FAILURE', code, 'DUPLICATE']);
    errorCode = code;
    return outputOf(['FAILURE', code], { kind: 'ERROR', code });
  }

  function onReplay(): DecisionOutput {
    if (lastResult === null) return outputOf(['USER_REPLAY', 'NO_RESULT'], { kind: 'REPLAY_EMPTY' });
    return outputOf(['USER_REPLAY', 'HAS_RESULT'], { kind: 'REPLAY', result: cloneResult(lastResult) });
  }

  function onAnalysis(): DecisionOutput {
    const phase = phaseOf(snapshot.state);
    if (phase === 'ERROR') return outputOf(['ANALYSIS_IGNORED', 'ERROR_STATE']);
    if (phase === 'STARTUP') return outputOf(['ANALYSIS_IGNORED', 'NOT_READY']);
    if (snapshot.backgrounded) return outputOf(['ANALYSIS_IGNORED', 'BACKGROUNDED']);
    // Lượt 2: cổng SPEAKING và nhánh 1..7. Lượt 1 chưa công bố gì nên không bao giờ đọc nhầm.
    return outputOf(['ANALYSIS_NOT_IMPLEMENTED']);
  }

  return {
    get state() {
      return snapshot.state;
    },
    get lastResult() {
      return lastResult === null ? null : cloneResult(lastResult);
    },
    handle(input: DecisionInput): DecisionOutput {
      switch (input.type) {
        case 'FAILURE': return onFailure(input.code);
        case 'SYSTEM': return onSystem(input.event);
        case 'USER_REPLAY': return onReplay();
        case 'ANALYSIS': return onAnalysis();
        default: return outputOf(['UNKNOWN_INPUT']);
      }
    },
    reset(): void {
      snapshot = INITIAL_SNAPSHOT;
      lastResult = null;
      memory = freshMemory();
      errorCode = null;
    },
  };
}