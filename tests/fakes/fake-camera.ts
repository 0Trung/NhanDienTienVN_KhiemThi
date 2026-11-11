import type { AppError, CameraStatus, CapturedFrame, FrameMeta, ICameraService } from '../../src/contracts';
import { makeFrameMeta } from './factories';

/**
 * ImageBitmap giả. close() được gọi nhiều lần vẫn chỉ tính một lần.
 * `onClose` gọi đúng một lần khi bitmap bị đóng.
 */
export function makeFakeBitmap(width: number, height: number, onClose: () => void = () => undefined): ImageBitmap {
  let closed = false;
  const fake = {
    width,
    height,
    close(): void {
      if (closed) return;
      closed = true;
      onClose();
    },
  };
  return fake as unknown as ImageBitmap;
}

export interface FakeCameraOptions {
  /** Trong môi trường Node không có DOM, video mặc định là một đối tượng rỗng đóng vai giữ chỗ. */
  video?: HTMLVideoElement;
  torchSupported?: boolean;
  /** Nếu đặt, start() chuyển sang ERROR và ném lỗi này. */
  startError?: AppError;
  width?: number;
  height?: number;
}

/** Camera giả: test tự đẩy khung hình bằng emitFrame và đếm bitmap bên nhận đã close. */
export class FakeCamera implements ICameraService {
  readonly video: HTMLVideoElement;
  startError: AppError | null;
  torchOn = false;
  samplingFps: number | null = null;
  startCalls = 0;
  stopCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  torchCalls = 0;
  createdBitmaps = 0;
  closedBitmaps = 0;

  private currentStatus: CameraStatus = 'IDLE';
  private readonly supportsTorch: boolean;
  private readonly width: number;
  private readonly height: number;
  private nextFrameId = 1;
  private readonly frameHandlers = new Set<(f: CapturedFrame) => void | Promise<void>>();
  private readonly statusHandlers = new Set<(s: CameraStatus, error?: AppError) => void>();

  constructor(options: FakeCameraOptions = {}) {
    this.video =
      options.video ??
      (typeof document !== 'undefined' ? document.createElement('video') : ({} as HTMLVideoElement));
    this.supportsTorch = options.torchSupported ?? true;
    this.startError = options.startError ?? null;
    this.width = options.width ?? 640;
    this.height = options.height ?? 480;
  }

  get status(): CameraStatus {
    return this.currentStatus;
  }

  get torchSupported(): boolean {
    return this.supportsTorch;
  }

  /** Số bitmap đã tạo nhưng bên nhận chưa close. */
  get openBitmaps(): number {
    return this.createdBitmaps - this.closedBitmaps;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    this.setStatus('REQUESTING');
    if (this.startError) {
      this.setStatus('ERROR', this.startError);
      throw this.startError;
    }
    this.setStatus('ACTIVE');
  }

  stop(): void {
    this.stopCalls += 1;
    this.setStatus('IDLE');
  }

  pause(): void {
    this.pauseCalls += 1;
    if (this.currentStatus === 'ACTIVE') this.setStatus('PAUSED');
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.currentStatus === 'PAUSED') this.setStatus('ACTIVE');
  }

  setSampling(fps: number): void {
    this.samplingFps = fps;
  }

  onFrame(handler: (f: CapturedFrame) => void | Promise<void>): () => void {
    this.frameHandlers.add(handler);
    return () => {
      this.frameHandlers.delete(handler);
    };
  }

  onStatus(handler: (s: CameraStatus, error?: AppError) => void): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  async setTorch(on: boolean): Promise<boolean> {
    this.torchCalls += 1;
    if (!this.supportsTorch) return false;
    this.torchOn = on;
    return true;
  }

  /** Đổi trạng thái và báo cho mọi handler onStatus. */
  setStatus(status: CameraStatus, error?: AppError): void {
    this.currentStatus = status;
    for (const handler of [...this.statusHandlers]) handler(status, error);
  }

  /**
   * Đẩy một khung hình tới mọi handler, chờ từng handler (kể cả async) xong mới trả về,
   * giống camera thật chờ xử lý xong mới lấy khung kế. Bên nhận chịu trách nhiệm close bitmap.
   */
  async emitFrame(overrides: Partial<FrameMeta> = {}): Promise<CapturedFrame> {
    const frameId = overrides.frameId ?? this.nextFrameId++;
    const meta = makeFrameMeta({
      frameId,
      width: this.width,
      height: this.height,
      timestamp: frameId * 333,
      ...overrides,
    });
    this.createdBitmaps += 1;
    const bitmap = makeFakeBitmap(meta.width, meta.height, () => {
      this.closedBitmaps += 1;
    });
    const frame: CapturedFrame = { bitmap, meta };
    for (const handler of [...this.frameHandlers]) await handler(frame);
    return frame;
  }
}