import { AppError } from '../../src/contracts';
import type { CapturedFrame, FrameMeta, IInferenceClient, InferenceResult, ModelInfo } from '../../src/contracts';
import { makeInferenceResult } from './factories';

/** Một bước trong kịch bản: kết quả, null (khung bị bỏ), lỗi để ném, hoặc hàm tính kết quả theo khung. */
export type FakeInferenceStep =
  | InferenceResult
  | null
  | AppError
  | ((frame: CapturedFrame) => InferenceResult | null);

export interface FakeInferenceOptions {
  /** Nếu đặt, init() ném lỗi này. */
  initError?: AppError;
  info?: Partial<ModelInfo>;
}

/**
 * Bộ suy luận giả chạy theo kịch bản (hàng đợi). Hết kịch bản thì trả kết quả rỗng (không có tiền).
 * Luôn close bitmap của khung (đúng hợp đồng IInferenceClient), kể cả khi ném lỗi.
 * infer trước init ném INFERENCE_FAILED để lộ lỗi sai thứ tự gọi.
 */
export class FakeInference implements IInferenceClient {
  readonly inferred: FrameMeta[] = [];
  initCalls = 0;
  inferCalls = 0;
  disposeCalls = 0;
  initError: AppError | null;

  private isReady = false;
  private readonly info: ModelInfo;
  private readonly queue: FakeInferenceStep[] = [];

  constructor(options: FakeInferenceOptions = {}) {
    this.initError = options.initError ?? null;
    this.info = {
      version: 'fake',
      inputSize: 640,
      classCount: 9,
      backend: 'wasm',
      threads: 1,
      loadMs: 0,
      warmupMs: 0,
      ...options.info,
    };
  }

  get ready(): boolean {
    return this.isReady;
  }

  /** Thêm các bước vào cuối kịch bản. */
  enqueue(...steps: FakeInferenceStep[]): this {
    this.queue.push(...steps);
    return this;
  }

  async init(): Promise<ModelInfo> {
    this.initCalls += 1;
    if (this.initError) throw this.initError;
    this.isReady = true;
    return { ...this.info };
  }

  async infer(frame: CapturedFrame): Promise<InferenceResult | null> {
    this.inferCalls += 1;
    this.inferred.push(frame.meta);
    try {
      if (!this.isReady) throw new AppError('INFERENCE_FAILED', 'FakeInference: infer được gọi trước init');
      const step = this.queue.shift();
      if (step === undefined) return makeInferenceResult({ meta: frame.meta });
      if (step === null) return null;
      if (typeof step === 'function') return step(frame);
      if (step instanceof AppError) throw step;
      return step;
    } finally {
      frame.bitmap.close();
    }
  }

  dispose(): void {
    this.disposeCalls += 1;
    this.isReady = false;
  }
}