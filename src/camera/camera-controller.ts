import { DEFAULT_CONFIG } from '../config/app-config';
import type { AppError, CameraStatus, CapturedFrame, ICameraService, ITorchPort } from '../contracts';
import { createEventBus } from '../utils/event-bus';
import { createLogger } from '../utils/logger';
import { systemClock } from '../utils/time';
import type { Clock } from '../utils/time';
import { createCameraError, mapCameraError } from './camera-errors';
import { attachStream, createCameraSource, detachStream, prepareVideoElement } from './camera-service';
import type { MediaDevicesLike } from './camera-service';
import { createFrameCapture, sanitizeFps, systemScheduler } from './frame-capture';
import type { Scheduler } from './frame-capture';

const log = createLogger('camera');

/** Số lần tự mở lại camera sau khi track kết thúc ngoài ý muốn (F6). Mỗi lần gọi start()/resume() làm mới. */
const AUTO_RETRY_LIMIT = 1;

/** Phần của document và Wake Lock mà module dùng (tiêm đồ giả khi test). */
export interface DocumentLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
  createElement?(tagName: 'video'): HTMLVideoElement;
}
export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** Mọi thứ chạm DOM, đồng hồ, hẹn giờ đều tiêm được; bỏ trống thì lấy từ môi trường thật. */
export interface CameraControllerDeps {
  video?: HTMLVideoElement;
  fps?: number;
  torchPort?: ITorchPort;
  mediaDevices?: MediaDevicesLike;
  isSecureContext?: boolean;
  doc?: DocumentLike;
  wakeLock?: WakeLockLike;
  clock?: Clock;
  scheduler?: Scheduler;
  createBitmap?: (video: HTMLVideoElement) => Promise<ImageBitmap>;
}

/**
 * Cài ICameraService: ghép CameraSource (getUserMedia, đèn, lấy nét) với FrameCapture (lấy mẫu)
 * và quản lý trạng thái, vòng đời trang, Wake Lock, mở lại khi mất camera.
 * Dùng khi cần tiêm đồ giả (test); mã ứng dụng gọi createCameraService.
 */
export function createCameraController(deps: CameraControllerDeps = {}): ICameraService {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { wakeLock?: WakeLockLike });
  const doc: DocumentLike | undefined = deps.doc ?? (typeof document === 'undefined' ? undefined : document);
  const wakeLockApi = deps.wakeLock ?? nav?.wakeLock;
  const createBitmap = deps.createBitmap ?? ((v: HTMLVideoElement) => createImageBitmap(v));
  const defaultFps = DEFAULT_CONFIG.inference.targetFps;

  const created = deps.video ?? doc?.createElement?.('video');
  if (!created) throw createCameraError('UNSUPPORTED_BROWSER', 'NO_DOCUMENT');
  const video: HTMLVideoElement = created;
  prepareVideoElement(video);

  const bus = createEventBus<{ status: { status: CameraStatus; error?: AppError } }>();
  const source = createCameraSource({
    mediaDevices: deps.mediaDevices ?? nav?.mediaDevices,
    isSecureContext: deps.isSecureContext ?? (typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : undefined),
    ...(deps.torchPort ? { torchPort: deps.torchPort } : {}),
    onEnded: () => onTrackEnded(),
  });
  const capture = createFrameCapture({
    source: video,
    createBitmap: () => createBitmap(video),
    clock: deps.clock ?? systemClock,
    scheduler: deps.scheduler ?? systemScheduler,
    fps: sanitizeFps(deps.fps ?? defaultFps, defaultFps),
  });

  let status: CameraStatus = 'IDLE';
  let generation = 0; // tăng mỗi lần start()/stop(): kết quả của lần mở đã bị huỷ thì bỏ
  let startPromise: Promise<void> | null = null;
  let opChain: Promise<unknown> = Promise.resolve(); // mọi thao tác mở camera chạy lần lượt
  let manualPause = false; // app gọi pause(): không tự tiếp tục khi trang hiện lại
  let autoPaused = false; // tự tạm dừng vì trang bị ẩn
  let streamLost = false; // track kết thúc khi đang PAUSED: resume phải mở lại
  let retriesLeft = AUTO_RETRY_LIMIT;
  let torchWanted = false;
  let wakeLock: WakeLockSentinelLike | null = null;
  let lifecycleAttached = false;

  function setStatus(next: CameraStatus, error?: AppError): void {
    if (next === status && error === undefined) return;
    status = next;
    bus.emit('status', error === undefined ? { status: next } : { status: next, error });
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = opChain.then(job, job);
    opChain = run.catch(() => undefined);
    return run;
  }

  /* ───── Wake Lock ───── */
  async function acquireWakeLock(): Promise<void> {
    if (!wakeLockApi || wakeLock) return;
    try {
      const sentinel = await wakeLockApi.request('screen');
      if (status !== 'ACTIVE' || wakeLock) {
        void sentinel.release().catch(() => undefined);
        return;
      }
      wakeLock = sentinel;
      sentinel.addEventListener('release', () => {
        if (wakeLock === sentinel) wakeLock = null;
      });
    } catch (err) {
      log.debug('Không giữ được màn hình sáng (bỏ qua)', err);
    }
  }

  function releaseWakeLock(): void {
    const sentinel = wakeLock;
    wakeLock = null;
    if (sentinel) void sentinel.release().catch(() => undefined);
  }

  /* ───── Chuyển trạng thái ───── */
  function enterActive(): void {
    setStatus('ACTIVE');
    capture.start();
    void acquireWakeLock();
    if (torchWanted) void source.setTorch(true);
  }

  function pauseInternal(): void {
    capture.stop();
    releaseWakeLock();
    if (torchWanted) void source.setTorch(false); // tắt đèn khi tạm dừng, resume sẽ bật lại
    video.pause();
    setStatus('PAUSED');
  }

  function releaseStream(): void {
    source.close();
    detachStream(video);
  }

  /**
   * Mở camera, gắn vào video, vào ACTIVE. Lỗi được ghi vào status ERROR và trả về (không ném) để nơi gọi quyết định.
   * Trả null khi thành công hoặc khi lần mở này đã bị stop() huỷ (đã tự dọn).
   */
  async function connect(gen: number): Promise<AppError | null> {
    try {
      const stream = await source.open();
      if (gen !== generation) {
        source.close();
        return null;
      }
      await attachStream(video, stream);
      if (gen !== generation) {
        releaseStream();
        return null;
      }
    } catch (err) {
      if (gen !== generation) return null;
      releaseStream();
      const appError = mapCameraError(err);
      setStatus('ERROR', appError);
      return appError;
    }
    streamLost = false;
    enterActive();
    return null;
  }

  /** Mở lại sau khi mất camera. Lỗi được báo qua onStatus, không ném. */
  function reopen(gen: number): Promise<void> {
    return enqueue(async () => {
      if (gen !== generation) return;
      setStatus('REQUESTING');
      await connect(gen);
    });
  }

  function onTrackEnded(): void {
    if (status === 'PAUSED') {
      streamLost = true;
      return;
    }
    if (status !== 'ACTIVE') return;
    capture.stop();
    releaseWakeLock();
    setStatus('ERROR', createCameraError('CAMERA_IN_USE', 'TRACK_ENDED'));
    if (retriesLeft <= 0) return;
    retriesLeft -= 1;
    reopen(generation).catch((err: unknown) => log.error('Mở lại camera bị lỗi không mong đợi', err));
  }

  /* ───── Vòng đời trang ───── */
  async function resumeFromPause(): Promise<void> {
    if (status !== 'PAUSED') return;
    autoPaused = false;
    const gen = generation;
    if (streamLost || !source.isLive()) return reopen(gen);
    try {
      await video.play();
    } catch (err) {
      if (gen === generation && status === 'PAUSED') setStatus('ERROR', createCameraError('CAMERA_FAILED', err));
      return;
    }
    if (gen === generation && status === 'PAUSED') enterActive();
  }

  function onVisibilityChange(): void {
    if (doc?.visibilityState === 'hidden') {
      if (status !== 'ACTIVE') return;
      autoPaused = true;
      pauseInternal();
    } else if (status === 'PAUSED' && autoPaused && !manualPause) {
      resumeFromPause().catch((err: unknown) => log.error('Tự tiếp tục khi trang hiện lại bị lỗi', err));
    }
  }

  /* ───── ICameraService ───── */
  function start(): Promise<void> {
    if (status === 'ACTIVE') return Promise.resolve();
    if (status === 'PAUSED') return resume();
    if (startPromise) return startPromise;
    if (status === 'REQUESTING') return Promise.resolve(); // đang mở lại sau khi mất camera
    const gen = ++generation;
    retriesLeft = AUTO_RETRY_LIMIT;
    manualPause = autoPaused = streamLost = false;
    if (doc && !lifecycleAttached) {
      doc.addEventListener('visibilitychange', onVisibilityChange);
      lifecycleAttached = true;
    }
    setStatus('REQUESTING'); // đồng bộ, giống FakeCamera: người gọi thấy ngay trạng thái đang xin quyền
    const run = enqueue(async () => {
      if (gen !== generation) return; // stop() đã huỷ trong lúc chờ lượt: không mở camera làm gì
      const error = await connect(gen);
      if (error) {
        detachLifecycle();
        throw error;
      }
    });
    startPromise = run;
    const clear = (): void => {
      if (startPromise === run) startPromise = null;
    };
    run.then(clear, clear);
    return run;
  }

  function detachLifecycle(): void {
    if (doc && lifecycleAttached) doc.removeEventListener('visibilitychange', onVisibilityChange);
    lifecycleAttached = false;
  }

  function stop(): void {
    generation += 1;
    startPromise = null;
    capture.stop();
    releaseWakeLock();
    releaseStream();
    detachLifecycle();
    manualPause = autoPaused = streamLost = torchWanted = false;
    setStatus('IDLE');
  }

  function pause(): void {
    if (status !== 'ACTIVE' && status !== 'PAUSED') return;
    manualPause = true;
    if (status === 'ACTIVE') pauseInternal();
  }

  async function resume(): Promise<void> {
    manualPause = false;
    retriesLeft = AUTO_RETRY_LIMIT;
    await resumeFromPause();
  }

  async function setTorch(on: boolean): Promise<boolean> {
    const ok = await source.setTorch(on);
    if (ok) torchWanted = on;
    return ok;
  }

  return {
    video,
    get status(): CameraStatus {
      return status;
    },
    get torchSupported(): boolean {
      return source.torchSupported;
    },
    start,
    stop,
    pause,
    resume,
    setSampling: (fps: number) => capture.setFps(fps),
    onFrame: (handler: (f: CapturedFrame) => void | Promise<void>) => capture.addHandler(handler),
    onStatus: (handler: (s: CameraStatus, error?: AppError) => void) => bus.on('status', (e) => handler(e.status, e.error)),
    setTorch,
  };
}

/** Điểm vào theo bảng đăng ký xuất khẩu (P02). */
export function createCameraService(
  opts?: { video?: HTMLVideoElement; fps?: number; torchPort?: ITorchPort },
): ICameraService {
  return createCameraController({ ...opts });
}