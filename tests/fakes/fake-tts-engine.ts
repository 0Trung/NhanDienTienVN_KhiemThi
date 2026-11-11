import type { ITtsEngine, TtsCapabilities, TtsHooks } from '../../src/contracts';

export interface SpokenUtterance { text: string; rate: number; lang: string; audioKey?: string }

export interface FakeTtsEngineOptions {
  name?: ITtsEngine['name'];
  capabilities?: Partial<TtsCapabilities>;
  /** Nếu đặt, init() bị từ chối với giá trị này. */
  initError?: unknown;
}

/**
 * Engine đọc giả. KHÔNG tự kết thúc: test gọi finishCurrent() để báo onEnd (hoặc failCurrent() để báo onError).
 * - requiresUserGesture = true: speak bị từ chối (onError, ghi vào `rejected`) cho tới khi unlock() được gọi.
 * - speak khi đang có câu phát: câu mới thay câu cũ (không báo hook của câu cũ) và tăng `overlappingSpeaks`.
 * - cancel(): bỏ câu hiện tại, KHÔNG gọi onEnd.
 */
export class FakeTtsEngine implements ITtsEngine {
  readonly name: ITtsEngine['name'];
  readonly spoken: SpokenUtterance[] = [];
  readonly rejected: SpokenUtterance[] = [];
  unlockCalls = 0;
  cancelCalls = 0;
  overlappingSpeaks = 0;

  private readonly capabilities: TtsCapabilities;
  private readonly initError: unknown;
  private unlocked = false;
  private active: { utterance: SpokenUtterance; hooks: TtsHooks } | null = null;

  constructor(options: FakeTtsEngineOptions = {}) {
    this.name = options.name ?? 'native-tts';
    this.initError = options.initError;
    this.capabilities = {
      available: true,
      vietnameseVoice: true,
      offlineVietnamese: true,
      requiresUserGesture: false,
      ...options.capabilities,
    };
  }

  get isSpeaking(): boolean {
    return this.active !== null;
  }

  get texts(): string[] {
    return this.spoken.map((u) => u.text);
  }

  async init(): Promise<TtsCapabilities> {
    if (this.initError !== undefined) throw this.initError;
    return { ...this.capabilities };
  }

  unlock(): void {
    this.unlockCalls += 1;
    this.unlocked = true;
  }

  speak(text: string, opts: { rate: number; lang: string; audioKey?: string }, hooks: TtsHooks): void {
    const utterance: SpokenUtterance = { text, rate: opts.rate, lang: opts.lang, audioKey: opts.audioKey };
    if (this.capabilities.requiresUserGesture && !this.unlocked) {
      this.rejected.push(utterance);
      hooks.onError(new Error('FakeTtsEngine: cần unlock() trước khi phát'));
      return;
    }
    if (this.active !== null) this.overlappingSpeaks += 1;
    this.spoken.push(utterance);
    this.active = { utterance, hooks };
    hooks.onStart();
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.active = null;
  }

  /** Kết thúc câu hiện tại (gọi onEnd). Trả false nếu không có câu nào đang phát. */
  finishCurrent(): boolean {
    if (this.active === null) return false;
    const { hooks } = this.active;
    this.active = null;
    hooks.onEnd();
    return true;
  }

  /** Làm câu hiện tại thất bại (gọi onError). Trả false nếu không có câu nào đang phát. */
  failCurrent(error: unknown = new Error('FakeTtsEngine: lỗi phát giả lập')): boolean {
    if (this.active === null) return false;
    const { hooks } = this.active;
    this.active = null;
    hooks.onError(error);
    return true;
  }
}