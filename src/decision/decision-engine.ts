import type {
  AppConfig, AppErrorCode, DecisionInput, DecisionOutput, DecisionStatus, Denomination, FrameAnalysis,
  GuidanceCode, IDecisionEngine, RecognitionResult, SpeechIntent, SystemEvent,
} from '../contracts';
import { INITIAL_SNAPSHOT, phaseOf, transition } from './state-manager';
import type { AnalysisTrigger, StateTrigger, TransitionResult } from './state-manager';
import { calculateTotal } from './total-calculator';
import type { TotalCalculation } from './total-calculator';

/** Bộ nhớ ngắn hạn của việc quét. Xóa khi APP_FOREGROUNDED và reset(). */
interface ShortTermMemory {
  /** Chữ ký (mệnh giá từ trái sang phải) của kết quả đã công bố; null = chưa có hoặc tiền đã rời khung. */
  announcedSignature: string | null;
  /** `now` của khung đầu chuỗi khung trống hiện tại; null = đang không trống. */
  emptySince: number | null;
  /** `now` của khung đầu chuỗi khung chưa ổn định hiện tại; null = đang ổn định hoặc đã rẽ sang nhánh khác. */
  unstableSince: number | null;
  /** `now` lần cuối phát mỗi mã guidance (cooldown tính riêng theo từng mã). */
  guidanceAt: Partial<Record<GuidanceCode, number>>;
}

/** Lý do chặn ở nhánh 5; vừa là DecisionStatus vừa là GuidanceCode. */
type Block = 'PARTIAL_IN_FRAME' | 'BLUR' | 'LOW_LIGHT' | 'MULTI_NOT_ALLOWED';

const freshMemory = (): ShortTermMemory => ({ announcedSignature: null, emptySince: null, unstableSince: null, guidanceAt: {} });

/** Sao chép để module khác không sửa nhầm bản engine giữ: đọc lại phải y hệt lần đã đọc. */
const cloneResult = (r: RecognitionResult): RecognitionResult => ({ ...r, denominations: [...r.denominations] });

const guidanceReason = (speech: SpeechIntent | null): string => (speech === null ? 'GUIDANCE_COOLDOWN' : 'GUIDANCE_SPOKEN');

/** calculateTotal nhưng không ném lỗi: null nếu danh sách chốt hỏng (rỗng hoặc có giá trị lạ). */
function safeTotal(denominations: Denomination[]): TotalCalculation | null {
  try {
    return calculateTotal(denominations);
  } catch {
    return null;
  }
}

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
 * không I/O; thời gian chỉ đến từ trường `now` của đầu vào. Fail Safe: result khác null (và shouldCalculateTotal)
 * CHỈ xảy ra ở nhánh 7 của ANALYSIS, sau khi nhánh 1..6 đều đã loại trừ mọi nghi ngờ.
 *
 * Mã lý do (`reasons`) = [mã chính, ...mã phụ]:
 * - SYSTEM hợp lệ: [tên sự kiện] + BOTH_READY | WAIT_CAMERA | WAIT_MODEL | MEMORY_CLEARED;
 *   trái phép: ['ILLEGAL_TRANSITION', 'SỰ_KIỆN@TRẠNG_THÁI'] (bỏ qua, không đổi trạng thái).
 * - FAILURE: ['FAILURE', mã lỗi] (+ DUPLICATE khi đang ERROR cùng mã: im lặng). USER_REPLAY: ['USER_REPLAY', HAS_RESULT | NO_RESULT].
 * - ANALYSIS bị bỏ qua: ['ANALYSIS_IGNORED', ERROR_STATE | NOT_READY | BACKGROUNDED | SPEAKING] (+ SIGNATURE_RESET).
 * - ANALYSIS nhánh 1..7: NO_DETECTIONS (+ SIGNATURE_RESET) · CONFLICT · OVERLAP · UNSURE_PRESENT + CAUSE_<mã> ·
 *   BLOCKED_<PARTIAL_IN_FRAME | BLUR | LOW_LIGHT | MULTI_NOT_ALLOWED> · UNSTABLE (+ NO_CONSENSUS | TOTAL_FAILED) ·
 *   ANTI_REPEAT · CONFIRMED; nhánh có lời hướng dẫn kèm GUIDANCE_SPOKEN | GUIDANCE_COOLDOWN | GUIDANCE_WAIT (chưa đủ thời gian chờ).
 *
 * ERROR là trạng thái cuối: mọi FAILURE dẫn tới đó; thoát bằng reset() rồi APP_STARTED.
 * Trạng thái sau nhánh 4 và 5 đều là UNCERTAIN; sau anti-repeat là DETECTING.
 */
export function createDecisionEngine(config: AppConfig['decision']): IDecisionEngine {
  let snapshot = INITIAL_SNAPSHOT;
  let lastResult: RecognitionResult | null = null;
  let memory = freshMemory();
  let errorCode: AppErrorCode | null = null;

  function apply(trigger: StateTrigger): TransitionResult {
    const t = transition(snapshot, trigger);
    snapshot = t.snapshot;
    return t;
  }

  /** Dựng đầu ra. shouldCalculateTotal luôn đi cùng result: chỉ nhánh công bố mới truyền result. */
  function outputOf(
    reasons: string[],
    speech: SpeechIntent | null = null,
    status: DecisionStatus | null = null,
    result: RecognitionResult | null = null,
  ): DecisionOutput {
    return { state: snapshot.state, status, reasons, speech, result, shouldCalculateTotal: result !== null };
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

  /** Ghi nhận khung trống/không trống. Trả true nếu vừa xóa chữ ký đã công bố (tiền đã rời khung đủ lâu). */
  function trackEmpty(a: FrameAnalysis, now: number): boolean {
    if (a.detections.length > 0) {
      memory.emptySince = null;
      return false;
    }
    if (memory.emptySince === null) memory.emptySince = now;
    if (a.emptyStreak < config.emptyFramesToReset || memory.announcedSignature === null) return false;
    memory.announcedSignature = null;
    return true;
  }

  /** Phát guidance nếu mã này đã qua cooldown (tính riêng từng mã); ngược lại null. */
  function guide(code: GuidanceCode, now: number): SpeechIntent | null {
    const last = memory.guidanceAt[code];
    if (last !== undefined && now - last < config.guidanceCooldownMs) return null;
    memory.guidanceAt[code] = now;
    return { kind: 'GUIDANCE', code };
  }

  /** Nhánh 4: lời hướng dẫn hữu ích nhất cho khung còn tờ chưa chắc, xét theo thứ tự config.guidancePriority. */
  function unsureGuidance(a: FrameAnalysis): GuidanceCode {
    const active = new Set<GuidanceCode>(['LOW_CONFIDENCE']);
    if (a.position.partial) active.add('PARTIAL_IN_FRAME');
    if (a.position.tooSmall) active.add('TOO_FAR');
    if (a.quality.lowLight) active.add('LOW_LIGHT');
    if (a.quality.blurry) active.add('BLUR');
    return config.guidancePriority.find((code) => active.has(code)) ?? 'LOW_CONFIDENCE';
  }

  /** Nhánh 5: khung chỉ có tờ chắc nhưng bị chặn theo cờ cấu hình; null nếu không bị chặn. */
  function blockOf(a: FrameAnalysis, noteCount: number): Block | null {
    if (a.position.partial && config.blockOnPartial) return 'PARTIAL_IN_FRAME';
    if (a.quality.blurry && config.blockOnBlur) return 'BLUR';
    if (a.quality.lowLight && config.blockOnLowLight) return 'LOW_LIGHT';
    if (noteCount > 1 && config.multiNotePolicy === 'SINGLE_ONLY') return 'MULTI_NOT_ALLOWED';
    return null;
  }

  /** Đầu ra của một nhánh KHÔNG công bố: đổi trạng thái theo `trigger`, ngắt chuỗi "chưa ổn định". */
  function observe(trigger: AnalysisTrigger, status: DecisionStatus, reasons: string[], speech: SpeechIntent | null = null): DecisionOutput {
    memory.unstableSince = null;
    apply(trigger);
    return outputOf(reasons, speech, status);
  }

  function onAnalysis(a: FrameAnalysis, now: number): DecisionOutput {
    const phase = phaseOf(snapshot.state);
    if (phase === 'ERROR') return outputOf(['ANALYSIS_IGNORED', 'ERROR_STATE']);
    if (phase === 'STARTUP') return outputOf(['ANALYSIS_IGNORED', 'NOT_READY']);
    if (snapshot.backgrounded) return outputOf(['ANALYSIS_IGNORED', 'BACKGROUNDED']);
    const signatureReset = trackEmpty(a, now);
    if (phase === 'SPEAKING') return outputOf(['ANALYSIS_IGNORED', 'SPEAKING', ...(signatureReset ? ['SIGNATURE_RESET'] : [])]);

    // 1. Không có detection nào: NO_MONEY chỉ được nói sau khi trống liên tục đủ noMoneyGuidanceDelayMs.
    if (a.detections.length === 0) {
      const waited = memory.emptySince !== null && now - memory.emptySince >= config.noMoneyGuidanceDelayMs;
      const speech = waited ? guide('NO_MONEY', now) : null;
      const reasons = signatureReset ? ['NO_DETECTIONS', 'SIGNATURE_RESET'] : ['NO_DETECTIONS'];
      reasons.push(waited ? guidanceReason(speech) : 'GUIDANCE_WAIT');
      return observe('NO_MONEY_SEEN', 'NO_MONEY_CANDIDATE', reasons, speech);
    }
    // 2. Xung đột lớp.
    if (a.conflict.detected) {
      const speech = guide('CLASS_CONFLICT', now);
      return observe('UNCERTAIN_SEEN', 'CLASS_CONFLICT', ['CONFLICT', guidanceReason(speech)], speech);
    }
    // 3. Chồng lấn.
    if (a.overlap.detected) {
      const speech = guide('OVERLAP', now);
      return observe('OVERLAP_SEEN', 'OVERLAP', ['OVERLAP', guidanceReason(speech)], speech);
    }
    // 4. Còn tờ chưa chắc.
    if (a.unsure.length > 0) {
      const code = unsureGuidance(a);
      const speech = guide(code, now);
      return observe('UNCERTAIN_SEEN', 'LOW_CONFIDENCE', ['UNSURE_PRESENT', `CAUSE_${code}`, guidanceReason(speech)], speech);
    }
    // 5. Chỉ có tờ chắc nhưng bị chặn. Số tờ lấy số lớn hơn giữa detections và consensus để khung không nhất quán không lọt chính sách.
    const consensus = a.stability.stable ? a.stability.consensus : null;
    const block = blockOf(a, Math.max(a.detections.length, consensus?.length ?? 0));
    if (block !== null) {
      const speech = guide(block, now);
      return observe('UNCERTAIN_SEEN', block, [`BLOCKED_${block}`, guidanceReason(speech)], speech);
    }
    // 6. Chưa ổn định (hoặc "ổn định" mà không có danh sách chốt dùng được): im lặng, quá unstableGuidanceMs thì HOLD_STEADY.
    if (consensus === null || consensus.length === 0) {
      if (memory.unstableSince === null) memory.unstableSince = now;
      const waited = now - memory.unstableSince >= config.unstableGuidanceMs;
      const speech = waited ? guide('HOLD_STEADY', now) : null;
      apply('UNSTABLE_SEEN');
      const reasons = a.stability.stable ? ['UNSTABLE', 'NO_CONSENSUS'] : ['UNSTABLE'];
      return outputOf([...reasons, waited ? guidanceReason(speech) : 'GUIDANCE_WAIT'], speech, 'UNSTABLE');
    }
    // 7. Danh sách chốt: trùng chữ ký đã công bố thì im lặng (anti-repeat), ngược lại công bố kết quả mới.
    const denominations = consensus.map((d) => d.denomination);
    const signature = denominations.join(',');
    const status = denominations.length === 1 ? 'CONFIDENT_SINGLE' : 'CONFIDENT_MULTI';
    if (signature === memory.announcedSignature) return observe('STEADY_SEEN', status, ['ANTI_REPEAT']);
    const total = safeTotal(denominations);
    if (total === null) return observe('UNSTABLE_SEEN', 'UNSTABLE', ['UNSTABLE', 'TOTAL_FAILED']);

    const published = apply('RESULT_PUBLISHED');
    if (!published.accepted) return outputOf([...published.reasons]);
    const result: RecognitionResult = {
      status, count: total.count, denominations: total.denominations, total: total.total, formattedTotal: total.formattedTotal, timestamp: now,
    };
    memory.unstableSince = null;
    memory.announcedSignature = signature;
    lastResult = cloneResult(result);
    return outputOf(['CONFIRMED'], { kind: 'RESULT', result }, status, result);
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
        case 'ANALYSIS': return onAnalysis(input.analysis, input.now);
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