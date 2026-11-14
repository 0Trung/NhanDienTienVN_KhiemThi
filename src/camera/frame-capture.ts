import type { CapturedFrame } from '../contracts';
import { createLogger } from '../utils/logger';
import { clamp } from '../utils/math';
import type { Clock } from '../utils/time';

const log = createLogger('camera:capture');

/** Tốc độ lấy mẫu cho phép (khung/giây): ngoài khoảng này thì bị kẹp. */
export const MIN_SAMPLING_FPS = 0.2;
export const MAX_SAMPLING_FPS = 30;
/** HTMLMediaElement.HAVE_CURRENT_DATA: đã có ít nhất một khung hình để chụp. */
const HAVE_CURRENT_DATA = 2;
/** Không thấy khung video nào trong ngần này thì bỏ requestVideoFrameCallback, chuyển sang hẹn giờ để vòng lặp không đứng im. */
const VIDEO_STALL_MS = 1000;

export type FrameHandler = (frame: CapturedFrame) => void | Promise<void>;

/** Bộ hẹn giờ được tiêm vào để test chạy bằng đồng hồ giả. */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemScheduler: Scheduler = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** Phần của HTMLVideoElement mà vòng lấy mẫu cần. */
export interface FrameSource {
  readonly readyState: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  requestVideoFrameCallback?(callback: () => void): number;
  cancelVideoFrameCallback?(handle: number): void;
}

export interface FrameCaptureDeps {
  source: FrameSource;
  /** Chụp khung hiện tại của video, thường là () => createImageBitmap(video). */
  createBitmap: () => Promise<ImageBitmap>;
  clock: Clock;
  scheduler: Scheduler;
  fps: number;
}

export interface FrameCapture {
  /** Đăng ký handler; trả về hàm huỷ đăng ký. */
  addHandler(handler: FrameHandler): () => void;
  /** Bắt đầu hoặc tiếp tục lấy mẫu; gọi khi đang chạy thì vô hại. */
  start(): void;
  /** Dừng và huỷ mọi hẹn giờ; handler đang chạy được chạy nốt. */
  stop(): void;
  /** Đổi tốc độ, có hiệu lực ngay cả khi đang chờ. Giá trị không hợp lệ bị bỏ qua. */
  setFps(fps: number): void;
}

/** fps hợp lệ thì kẹp vào [MIN, MAX]; NaN, vô cực, ≤ 0 thì trả `fallback`. */
export function sanitizeFps(fps: number, fallback: number): number {
  return Number.isFinite(fps) && fps > 0 ? clamp(fps, MIN_SAMPLING_FPS, MAX_SAMPLING_FPS) : fallback;
}

function closeQuietly(bitmap: ImageBitmap): void {
  try {
    bitmap.close();
  } catch (err) {
    log.debug('bitmap.close() lỗi', err);
  }
}

/**
 * Vòng lấy mẫu tuần tự có backpressure: chụp → gọi lần lượt các handler và CHỜ xong → mới tính lần kế.
 * Khoảng cách giữa hai lần BẮT ĐẦU chụp ≥ 1000/fps, đã trừ thời gian handler tiêu tốn.
 * Có requestVideoFrameCallback thì chụp ở khung video mới đầu tiên đã đủ khoảng cách; không thì dùng hẹn giờ.
 */
export function createFrameCapture(deps: FrameCaptureDeps): FrameCapture {
  const { source, createBitmap, clock, scheduler } = deps;
  const handlers = new Set<FrameHandler>();
  let fps = sanitizeFps(deps.fps, MIN_SAMPLING_FPS);
  let running = false;
  let busy = false;
  let failing = false; // createImageBitmap đang lỗi liên tục: chỉ log lần đầu
  let nextFrameId = 1;
  let lastStart = Number.NEGATIVE_INFINITY;
  let useVideoCallback = typeof source.requestVideoFrameCallback === 'function';
  let waitTimer: unknown = null;
  let stallTimer: unknown = null;
  let videoCallback: number | null = null;

  function clearPending(): void {
    if (waitTimer !== null) scheduler.clearTimeout(waitTimer);
    if (stallTimer !== null) scheduler.clearTimeout(stallTimer);
    if (videoCallback !== null) source.cancelVideoFrameCallback?.(videoCallback);
    waitTimer = stallTimer = videoCallback = null;
  }

  function schedule(): void {
    if (!running || busy) return;
    clearPending();
    if (useVideoCallback && source.requestVideoFrameCallback) {
      videoCallback = source.requestVideoFrameCallback(onVideoFrame);
      stallTimer = scheduler.setTimeout(onStall, VIDEO_STALL_MS);
    } else {
      waitTimer = scheduler.setTimeout(() => {
        waitTimer = null;
        void tick();
      }, Math.max(0, 1000 / fps - (clock() - lastStart)));
    }
  }

  /** Mỗi khung video mới chỉ kiểm tra đã đủ khoảng cách chưa: đủ thì chụp, chưa thì chờ khung kế. */
  function onVideoFrame(): void {
    if (clock() - lastStart < 1000 / fps) return schedule();
    clearPending();
    void tick();
  }

  function onStall(): void {
    log.warn('requestVideoFrameCallback không phản hồi, chuyển sang lấy mẫu bằng hẹn giờ');
    useVideoCallback = false;
    schedule();
  }

  async function tick(): Promise<void> {
    if (!running || busy) return;
    busy = true;
    lastStart = clock();
    try {
      await captureAndDeliver(lastStart);
    } catch (err) {
      log.error('Lỗi không mong đợi trong vòng lấy mẫu', err);
    } finally {
      busy = false;
    }
    schedule();
  }

  async function captureAndDeliver(timestamp: number): Promise<void> {
    if (source.readyState < HAVE_CURRENT_DATA || source.videoWidth <= 0 || source.videoHeight <= 0) return;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createBitmap();
      failing = false;
    } catch (err) {
      if (!failing) log.warn('createImageBitmap(video) lỗi, bỏ qua khung này', err);
      failing = true;
      return;
    }
    if (!running || bitmap.width <= 0 || bitmap.height <= 0) return closeQuietly(bitmap);
    const frame: CapturedFrame = {
      bitmap,
      meta: { frameId: nextFrameId++, width: bitmap.width, height: bitmap.height, timestamp },
    };
    let called = 0;
    let failed = false;
    for (const handler of [...handlers]) {
      if (!handlers.has(handler)) continue;
      called += 1;
      try {
        await handler(frame);
      } catch (err) {
        failed = true;
        log.error('Handler onFrame ném lỗi, vòng lấy mẫu vẫn chạy', err);
      }
    }
    // Bên nhận tự close khi xử lý xong; chỉ đóng thay khi không ai nhận hoặc có handler lỗi.
    if (called === 0 || failed) closeQuietly(bitmap);
  }

  return {
    addHandler(handler) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      clearPending();
    },
    setFps(next) {
      const valid = sanitizeFps(next, Number.NaN);
      if (Number.isNaN(valid)) return log.warn(`Bỏ qua tốc độ lấy mẫu không hợp lệ: ${String(next)}`);
      fps = valid;
      if (waitTimer !== null) schedule();
    },
  };
}