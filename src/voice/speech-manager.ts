import type {
  AppConfig,
  HapticEvent,
  IHaptics,
  ISpeech,
  ITtsEngine,
  RecognitionResult,
  Settings,
  SpeechIntent,
  TtsCapabilities,
  TtsHooks,
  UtteranceEvent,
} from '../contracts';
import { createLogger } from '../utils/logger';
import { systemClock } from '../utils/time';
import { buildPrompt } from './prompt-manager';
import type { Prompt } from './prompt-manager';

const log = createLogger('speech');

/**
 * Ước lượng thời gian đọc để đặt watchdog: độ dài chữ × hệ số / tốc độ + đệm.
 * AppConfig.speech chưa có các tham số này nên tạm đặt ở đây (xem "Đề xuất sửa hợp đồng").
 */
export const WATCHDOG_MS_PER_CHAR = 120;
export const WATCHDOG_MARGIN_MS = 1000;

export interface SpeechManagerOptions {
  engines: ITtsEngine[];
  haptics: IHaptics;
  getSettings: () => Settings;
  config: AppConfig['speech'];
  now?: () => number;
}

/** Hẹn giờ được tiêm vào để test không phải chờ thật. */
export interface SpeechTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: SpeechTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

const UNAVAILABLE: TtsCapabilities = {
  available: false,
  vietnameseVoice: false,
  offlineVietnamese: false,
  requiresUserGesture: false,
};

/** Cắt câu dài theo dấu chấm thành các câu ngắn (mỗi câu giữ dấu chấm của nó). */
export function splitIntoUtterances(text: string): string[] {
  return (text.match(/[^.]+\.?/g) ?? []).map((s) => s.trim()).filter((s) => s !== '' && s !== '.');
}

/** Thời gian chờ tối đa cho một câu: số lớn hơn giữa maxUtteranceMs và ước lượng theo độ dài chữ. */
export function utteranceTimeoutMs(text: string, rate: number, maxUtteranceMs: number): number {
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const estimate = Math.ceil((text.length * WATCHDOG_MS_PER_CHAR) / safeRate) + WATCHDOG_MARGIN_MS;
  return Math.max(maxUtteranceMs, estimate);
}

function hapticFor(intent: SpeechIntent): HapticEvent | null {
  switch (intent.kind) {
    case 'CAMERA_READY':
      return 'START';
    case 'RESULT':
      return 'SUCCESS';
    case 'ERROR':
      return 'ERROR';
    case 'GUIDANCE':
      return intent.code === 'LOW_CONFIDENCE' || intent.code === 'CLASS_CONFLICT' ? 'UNCERTAIN' : null;
    default:
      return null;
  }
}

interface QueueItem {
  readonly kind: SpeechIntent['kind'];
  readonly prompt: Prompt;
  readonly chunks: readonly string[];
  readonly enqueuedAt: number;
  next: number;
  started: boolean;
}

interface ActiveUtterance {
  readonly id: number;
  readonly item: QueueItem;
  readonly watchdog: unknown;
}

interface ProbedEngine {
  engine: ITtsEngine;
  caps: TtsCapabilities;
}

type EndOutcome = 'ended' | 'error' | 'cancelled' | 'watchdog';

/** Chọn engine: aria-live (nếu chọn đọc qua trình đọc màn hình) → engine đầu tiên có giọng Việt → audio-clip → engine nào dùng được. */
function chooseEngine(probed: ProbedEngine[], speechOutput: Settings['speechOutput']): ProbedEngine | null {
  const usable = probed.filter((p) => p.caps.available);
  if (speechOutput === 'SCREEN_READER') {
    const reader = usable.find((p) => p.engine.name === 'aria-live');
    if (reader !== undefined) return reader;
  }
  const voiced = usable.find((p) => p.engine.name !== 'audio-clip' && p.caps.vietnameseVoice);
  if (voiced !== undefined) return voiced;
  const clip = usable.find((p) => p.engine.name === 'audio-clip');
  if (clip !== undefined) return clip;
  const any = usable[0];
  return any === undefined ? null : { engine: any.engine, caps: { ...any.caps, vietnameseVoice: false } };
}

/**
 * Bộ điều phối giọng nói với hẹn giờ tiêm vào (dùng cho test và cho createSpeechManager).
 * Bảo đảm: tại mọi thời điểm chỉ có MỘT utterance đang phát; mỗi utterance có đúng một sự kiện start và một end
 * (kể cả khi bị hủy, lỗi hay watchdog); hook muộn của utterance cũ bị bỏ qua. Phải await init() trước khi say().
 */
export function createSpeechManagerWithTimers(o: SpeechManagerOptions, timers: SpeechTimers): ISpeech {
  const { engines, haptics, getSettings, config } = o;
  const now = o.now ?? systemClock;
  const handlers = new Set<(e: UtteranceEvent) => void>();
  const spokenAt = new Map<string, number>(); // câu → lần cuối người dùng được báo (bắt đầu đọc hoặc đọc xong)
  let selected: ProbedEngine | null = null;
  let queue: QueueItem[] = []; // luôn sắp theo ưu tiên giảm dần; đầu hàng là mục đang đọc dở hoặc sắp đọc
  let active: ActiveUtterance | null = null;
  let gapTimer: unknown = null;
  let lastEndAt = Number.NEGATIVE_INFINITY;
  let lastResult: RecognitionResult | null = null;
  let nextId = 1;

  function safely(label: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      log.error(`${label} ném lỗi`, e);
    }
  }

  function emit(phase: UtteranceEvent['phase'], kind: UtteranceEvent['kind']): void {
    for (const handler of [...handlers]) {
      safely('Bộ nghe sự kiện utterance', () => handler({ phase, kind }));
    }
  }

  function playHaptic(intent: SpeechIntent): void {
    const event = hapticFor(intent);
    if (event !== null) safely('haptics.play', () => haptics.play(event));
  }

  function isActive(id: number): boolean {
    return active !== null && active.id === id;
  }

  function removeItem(item: QueueItem): void {
    queue = queue.filter((q) => q !== item);
  }

  /** Bỏ hướng dẫn chờ quá guidanceStaleMs (chỉ mục chưa đọc câu nào) và quên các câu đã quá cửa sổ chống lặp. */
  function dropStale(): void {
    const t = now();
    queue = queue.filter((item) => {
      const stale = item.kind === 'GUIDANCE' && !item.started && t - item.enqueuedAt > config.guidanceStaleMs;
      if (stale) log.debug('Bỏ hướng dẫn quá hạn:', item.prompt.text);
      return !stale;
    });
    for (const [text, at] of spokenAt) {
      if (t - at >= config.dedupeWindowMs) spokenAt.delete(text);
    }
  }

  function isRepeat(text: string): boolean {
    if (queue.some((item) => item.prompt.text === text)) return true;
    const at = spokenAt.get(text);
    return at !== undefined && now() - at < config.dedupeWindowMs;
  }

  function remainingGapMs(): number {
    return Math.max(0, Math.min(config.minGapMs, lastEndAt + config.minGapMs - now()));
  }

  /** Kết thúc utterance đang phát (đúng một lần), rồi đọc tiếp. Hook của utterance cũ (id lệch) bị bỏ qua. */
  function endUtterance(id: number, outcome: EndOutcome): void {
    const current = active;
    if (current === null || current.id !== id) return;
    timers.clearTimeout(current.watchdog);
    active = null;
    lastEndAt = now();
    const { item } = current;
    if (outcome !== 'ended' || item.next >= item.chunks.length) removeItem(item); // lỗi, hủy, watchdog: bỏ phần còn lại
    if (outcome === 'error' && item.next === 1) spokenAt.delete(item.prompt.text); // chưa nghe được gì: cho phép thử lại
    else spokenAt.set(item.prompt.text, lastEndAt);
    emit('end', item.kind);
    pump();
  }

  function cancelActive(): void {
    const current = active;
    if (current === null) return;
    safely('engine.cancel', () => selected?.engine.cancel());
    endUtterance(current.id, 'cancelled');
  }

  function cancelEverything(): void {
    queue = [];
    if (gapTimer !== null) {
      timers.clearTimeout(gapTimer);
      gapTimer = null;
    }
    cancelActive();
  }

  function onWatchdog(id: number): void {
    if (!isActive(id)) return;
    log.warn('Watchdog: engine không báo kết thúc, tự kết thúc câu');
    safely('engine.cancel', () => selected?.engine.cancel());
    endUtterance(id, 'watchdog');
  }

  function startChunk(engine: ITtsEngine, item: QueueItem): void {
    const text = item.chunks[item.next];
    if (text === undefined) {
      removeItem(item);
      pump();
      return;
    }
    const settings = getSettings();
    item.next += 1;
    item.started = true;
    spokenAt.set(item.prompt.text, now());
    const id = nextId;
    nextId += 1;
    const timeout = utteranceTimeoutMs(text, settings.speechRate, config.maxUtteranceMs);
    const watchdog = timers.setTimeout(() => safely('watchdog', () => onWatchdog(id)), timeout);
    active = { id, item, watchdog };
    emit('start', item.kind);
    if (!isActive(id)) return; // một bộ nghe đã hủy hoặc ngắt ngay trong sự kiện start
    const hooks: TtsHooks = {
      onStart: () => undefined,
      onEnd: () => safely('onEnd', () => endUtterance(id, 'ended')),
      onError: (e) =>
        safely('onError', () => {
          log.warn('Engine báo lỗi khi đọc:', e);
          endUtterance(id, 'error');
        }),
    };
    const base = { rate: settings.speechRate, lang: settings.voiceLanguage };
    const opts =
      engine.name === 'audio-clip' && item.prompt.audioKey !== undefined ? { ...base, audioKey: item.prompt.audioKey } : base;
    try {
      engine.speak(text, opts, hooks);
    } catch (e) {
      log.warn('engine.speak ném lỗi:', e);
      endUtterance(id, 'error');
    }
  }

  /** Đọc mục đầu hàng đợi nếu đang rảnh và đã đủ khoảng lặng; chưa đủ thì hẹn giờ. */
  function pump(): void {
    if (active !== null || gapTimer !== null) return;
    dropStale();
    const item = queue[0];
    if (item === undefined) return;
    if (selected === null || !getSettings().voiceEnabled) {
      queue = [];
      return;
    }
    const wait = remainingGapMs();
    if (wait > 0) {
      gapTimer = timers.setTimeout(
        () =>
          safely('gap', () => {
            gapTimer = null;
            pump();
          }),
        wait,
      );
      return;
    }
    startChunk(selected.engine, item);
  }

  function accept(intent: SpeechIntent, prompt: Prompt, settings: Settings): void {
    dropStale();
    if (intent.kind !== 'REPLAY' && isRepeat(prompt.text)) {
      log.debug('Bỏ câu lặp:', prompt.text);
      return;
    }
    const head = queue[0];
    const inProgress = head !== undefined && head.started ? head : undefined;
    if (intent.kind === 'GUIDANCE' && inProgress !== undefined && (inProgress.kind === 'RESULT' || inProgress.kind === 'REPLAY')) {
      log.debug('Hướng dẫn không được ngắt kết quả đang đọc:', prompt.text);
      return;
    }

    playHaptic(intent);

    const engine = selected === null ? null : selected.engine;
    const canSpeak =
      settings.voiceEnabled && engine !== null && (engine.name !== 'audio-clip' || prompt.audioKey !== undefined);
    if (engine === null || !canSpeak) {
      if (!settings.voiceEnabled) cancelEverything();
      spokenAt.set(prompt.text, now());
      return;
    }

    // Ưu tiên cao hơn: xóa mục thấp hơn (kể cả mục đang đọc). Cùng supersedeKey: thay mục đang chờ.
    const lowered = queue.filter((q) => q.prompt.priority < prompt.priority);
    queue = queue.filter(
      (q) => q.prompt.priority >= prompt.priority && !(q.prompt.supersedeKey === prompt.supersedeKey && !q.started),
    );
    queue.push({
      kind: intent.kind,
      prompt,
      chunks: engine.name === 'audio-clip' ? [prompt.text] : splitIntoUtterances(prompt.text),
      enqueuedAt: now(),
      next: 0,
      started: false,
    });
    if (active !== null && lowered.some((q) => q === active?.item)) cancelActive();
    pump();
  }

  function say(intent: SpeechIntent): void {
    safely('say', () => {
      const settings = getSettings();
      let prompt: Prompt;
      try {
        prompt = buildPrompt(intent, settings);
      } catch (e) {
        // Fail Safe: dữ liệu không đáng tin thì KHÔNG đọc số tiền; kết quả hỏng được thay bằng lời từ chối an toàn.
        log.error('Không dựng được câu nói, bỏ qua:', e);
        if (intent.kind === 'RESULT') say({ kind: 'GUIDANCE', code: 'LOW_CONFIDENCE' });
        return;
      }
      if (intent.kind === 'RESULT') lastResult = intent.result;
      accept(intent, prompt, settings);
    });
  }

  async function probe(engine: ITtsEngine): Promise<ProbedEngine> {
    try {
      return { engine, caps: { ...(await engine.init()) } };
    } catch (e) {
      log.warn(`Engine ${engine.name} init lỗi, coi như không dùng được:`, e);
      return { engine, caps: { ...UNAVAILABLE } };
    }
  }

  async function init(): Promise<TtsCapabilities> {
    safely('init', cancelEverything);
    selected = null;
    try {
      const speechOutput = getSettings().speechOutput;
      selected = chooseEngine(await Promise.all(engines.map(probe)), speechOutput);
    } catch (e) {
      log.error('Chọn engine lỗi:', e);
    }
    if (selected === null) log.warn('Không có engine đọc nào dùng được');
    else log.info(`Chọn engine ${selected.engine.name}`);
    return selected === null ? { ...UNAVAILABLE } : { ...selected.caps };
  }

  return {
    /** true khi có một utterance đang phát (từ start đến end); không tính khoảng lặng giữa hai câu. */
    get isSpeaking(): boolean {
      return active !== null;
    },
    init,
    unlock(): void {
      for (const engine of engines) safely(`${engine.name}.unlock`, () => engine.unlock());
    },
    say,
    replayLast(): void {
      say(lastResult !== null ? { kind: 'REPLAY', result: lastResult } : { kind: 'REPLAY_EMPTY' });
    },
    cancelAll(): void {
      safely('cancelAll', cancelEverything);
    },
    onUtterance(handler: (e: UtteranceEvent) => void): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

/** Bộ điều phối giọng nói thật (hẹn giờ của hệ thống). */
export function createSpeechManager(o: SpeechManagerOptions): ISpeech {
  return createSpeechManagerWithTimers(o, REAL_TIMERS);
}