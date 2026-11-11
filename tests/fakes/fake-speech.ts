import type {
  ISpeech,
  RecognitionResult,
  SpeechIntent,
  TtsCapabilities,
  UtteranceEvent,
} from '../../src/contracts';

export interface FakeSpeechOptions {
  /** true (mặc định): say() phát ngay sự kiện utterance 'start'; 'end' chỉ phát khi gọi finishCurrent(). */
  autoStart?: boolean;
  capabilities?: Partial<TtsCapabilities>;
}

/** ISpeech giả: ghi lại mọi SpeechIntent và mô phỏng sự kiện utterance. */
export class FakeSpeech implements ISpeech {
  readonly intents: SpeechIntent[] = [];
  initCalls = 0;
  unlockCalls = 0;
  replayCalls = 0;
  cancelCalls = 0;

  private speaking = false;
  private current: SpeechIntent | null = null;
  private lastResult: RecognitionResult | null = null;
  private readonly autoStart: boolean;
  private readonly capabilities: TtsCapabilities;
  private readonly handlers = new Set<(e: UtteranceEvent) => void>();

  constructor(options: FakeSpeechOptions = {}) {
    this.autoStart = options.autoStart ?? true;
    this.capabilities = {
      available: true,
      vietnameseVoice: true,
      offlineVietnamese: true,
      requiresUserGesture: false,
      ...options.capabilities,
    };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get lastIntent(): SpeechIntent | undefined {
    return this.intents.at(-1);
  }

  async init(): Promise<TtsCapabilities> {
    this.initCalls += 1;
    return { ...this.capabilities };
  }

  unlock(): void {
    this.unlockCalls += 1;
  }

  say(intent: SpeechIntent): void {
    this.intents.push(intent);
    if (intent.kind === 'RESULT') this.lastResult = intent.result;
    if (this.autoStart) {
      this.current = intent;
      this.speaking = true;
      this.emitUtterance({ phase: 'start', kind: intent.kind });
    }
  }

  /** Giống ISpeech thật: đọc lại kết quả gần nhất, hoặc REPLAY_EMPTY nếu chưa có. */
  replayLast(): void {
    this.replayCalls += 1;
    this.say(this.lastResult ? { kind: 'REPLAY', result: this.lastResult } : { kind: 'REPLAY_EMPTY' });
  }

  cancelAll(): void {
    this.cancelCalls += 1;
    this.current = null;
    this.speaking = false;
  }

  onUtterance(handler: (e: UtteranceEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Kết thúc câu hiện tại (phát sự kiện 'end'). Trả false nếu không có câu nào. */
  finishCurrent(): boolean {
    if (this.current === null) return false;
    const { kind } = this.current;
    this.current = null;
    this.speaking = false;
    this.emitUtterance({ phase: 'end', kind });
    return true;
  }

  /** Tự phát một sự kiện utterance tới mọi handler. */
  emitUtterance(event: UtteranceEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }

  /** Các ý định đã nói thuộc một loại, ví dụ ofKind('GUIDANCE'). */
  ofKind<K extends SpeechIntent['kind']>(kind: K): Array<Extract<SpeechIntent, { kind: K }>> {
    return this.intents.filter((i): i is Extract<SpeechIntent, { kind: K }> => i.kind === kind);
  }
}