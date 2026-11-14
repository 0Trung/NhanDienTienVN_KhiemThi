import { createCameraController } from '../../src/camera/camera-controller';
import type { CameraControllerDeps, DocumentLike, WakeLockLike, WakeLockSentinelLike } from '../../src/camera/camera-controller';
import type { MediaDevicesLike } from '../../src/camera/camera-service';
import type { Scheduler } from '../../src/camera/frame-capture';
import { setLogSink } from '../../src/utils/logger';
import type { Clock } from '../../src/utils/time';
import { makeFakeBitmap } from '../fakes/fake-camera';

setLogSink(() => undefined); // test không cần in log ra console

/** Lỗi giống DOMException: chỉ cần có name. */
export const domError = (name: string): Error => Object.assign(new Error(name), { name });

/** Chờ mọi microtask đang treo chạy xong (qua một lượt vòng lặp sự kiện). */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface FakeTime {
  clock: Clock;
  scheduler: Scheduler;
  /** Chạy các hẹn giờ đến hạn theo thứ tự thời gian, chờ phần async xử lý xong sau mỗi hẹn giờ. */
  advance(ms: number): Promise<void>;
  /** Một lần chờ ms mili-giây theo đồng hồ giả (cho handler "chậm"). */
  sleep(ms: number): Promise<void>;
}

export function createFakeTime(): FakeTime {
  let now = 0;
  let nextId = 1;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const scheduler: Scheduler = {
    setTimeout(fn, ms) {
      timers.push({ id: nextId, at: now + Math.max(0, ms), fn });
      return nextId++;
    },
    clearTimeout(handle) {
      const index = timers.findIndex((t) => t.id === handle);
      if (index !== -1) timers.splice(index, 1);
    },
  };
  return {
    clock: () => now,
    scheduler,
    sleep: (ms) => new Promise<void>((resolve) => scheduler.setTimeout(resolve, ms)),
    async advance(ms) {
      const target = now + ms;
      await flush();
      for (let due = nextDue(); due; due = nextDue()) {
        timers.splice(timers.indexOf(due), 1);
        now = Math.max(now, due.at);
        due.fn();
        await flush();
      }
      now = target;
      await flush();
      function nextDue(): (typeof timers)[number] | undefined {
        return timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      }
    },
  };
}

export class FakeVideo {
  readyState = 4;
  videoWidth = 1280;
  videoHeight = 720;
  srcObject: unknown = null;
  muted = false;
  autoplay = false;
  playsInline = false;
  playCalls = 0;
  pauseCalls = 0;
  playError: unknown = null;
  readonly attrs = new Map<string, string>();
  readonly style: Record<string, string> = {};
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  play(): Promise<void> {
    this.playCalls += 1;
    return this.playError ? Promise.reject(this.playError) : Promise.resolve();
  }
  pause(): void {
    this.pauseCalls += 1;
  }
  get element(): HTMLVideoElement {
    return this as unknown as HTMLVideoElement;
  }
}

/** Video có requestVideoFrameCallback; test tự bắn khung bằng fireFrame(). */
export class FakeCallbackVideo extends FakeVideo {
  pending: (() => void) | null = null;
  cancelCalls = 0;
  requestVideoFrameCallback(cb: () => void): number {
    this.pending = cb;
    return 1;
  }
  cancelVideoFrameCallback(): void {
    this.cancelCalls += 1;
    this.pending = null;
  }
  fireFrame(): void {
    const cb = this.pending;
    this.pending = null;
    cb?.();
  }
}

export class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  onended: (() => void) | null = null;
  stopCalls = 0;
  applied: unknown[] = [];
  rejectApply = false;
  constructor(
    readonly caps: Record<string, unknown> = {},
    readonly settings: { deviceId?: string } = {},
  ) {}
  getCapabilities(): Record<string, unknown> {
    return this.caps;
  }
  getSettings(): { deviceId?: string } {
    return this.settings;
  }
  applyConstraints(constraints: unknown): Promise<void> {
    this.applied.push(constraints);
    return this.rejectApply ? Promise.reject(domError('OverconstrainedError')) : Promise.resolve();
  }
  stop(): void {
    this.stopCalls += 1;
    this.readyState = 'ended';
  }
  /** Giả lập app khác chiếm camera hoặc rút camera: track kết thúc mà không ai gọi stop(). */
  endExternally(): void {
    this.readyState = 'ended';
    this.onended?.();
  }
}

export const makeDevice = (deviceId: string, label: string): MediaDeviceInfo =>
  ({ deviceId, label, kind: 'videoinput', groupId: '' }) as MediaDeviceInfo;

/** getUserMedia theo kịch bản: 'ok' tạo track mới, chuỗi khác là tên lỗi bị từ chối. Hết kịch bản thì 'ok'. */
export class FakeMediaDevices implements MediaDevicesLike {
  readonly calls: MediaStreamConstraints[] = [];
  readonly tracks: FakeTrack[] = [];
  devices: MediaDeviceInfo[] = [];
  /** Đặt để giữ getUserMedia treo cho tới khi gate được giải phóng (giả lập hộp thoại xin quyền đang mở). */
  gate: Promise<void> | null = null;
  constructor(
    private readonly script: string[] = [],
    private readonly trackCaps: Record<string, unknown> = {},
    private readonly trackSettings: { deviceId?: string } = {},
  ) {}
  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    this.calls.push(constraints);
    if (this.gate) await this.gate;
    const step = this.script.shift() ?? 'ok';
    if (step !== 'ok') throw domError(step);
    const track = new FakeTrack(this.trackCaps, { ...this.trackSettings });
    this.tracks.push(track);
    return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  }
  enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return Promise.resolve(this.devices);
  }
}

export class FakeDocument implements DocumentLike {
  visibilityState = 'visible';
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
  setVisibility(state: 'hidden' | 'visible'): void {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
  }
}

export class FakeWakeLock implements WakeLockLike {
  requests = 0;
  releases = 0;
  request(): Promise<WakeLockSentinelLike> {
    this.requests += 1;
    let released = false;
    const release = (): Promise<void> => {
      if (!released) this.releases += 1;
      released = true;
      return Promise.resolve();
    };
    return Promise.resolve({ release, addEventListener: () => undefined });
  }
  /** Số khoá đang được giữ. */
  get held(): number {
    return this.requests - this.releases;
  }
}

/** Đếm bitmap đã tạo và đã đóng để phát hiện rò. `failures` > 0: các lần tạo kế tiếp bị lỗi. */
export class BitmapCounter {
  created = 0;
  closed = 0;
  failures = 0;
  readonly create = (): Promise<ImageBitmap> => {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(domError('InvalidStateError'));
    }
    this.created += 1;
    return Promise.resolve(makeFakeBitmap(1280, 720, () => (this.closed += 1)));
  };
  get open(): number {
    return this.created - this.closed;
  }
}

export interface HarnessOptions extends Partial<CameraControllerDeps> {
  script?: string[];
  trackCaps?: Record<string, unknown>;
  trackSettings?: { deviceId?: string };
  fakeVideo?: FakeVideo;
}

/** Camera thật nối với toàn bộ đồ giả: không chạm DOM, mạng hay đồng hồ thật. fps 2 → 500 ms một khung. */
export function makeHarness(options: HarnessOptions = {}) {
  const { script, trackCaps, trackSettings, fakeVideo, ...overrides } = options;
  const time = createFakeTime();
  const video = fakeVideo ?? new FakeVideo();
  const media = new FakeMediaDevices(script, trackCaps, trackSettings);
  const doc = new FakeDocument();
  const wakeLock = new FakeWakeLock();
  const bitmaps = new BitmapCounter();
  const camera = createCameraController({
    video: video.element,
    fps: 2,
    mediaDevices: media,
    isSecureContext: true,
    doc,
    wakeLock,
    clock: time.clock,
    scheduler: time.scheduler,
    createBitmap: bitmaps.create,
    ...overrides,
  });
  const statuses: string[] = [];
  camera.onStatus((status, error) => statuses.push(error ? `${status}:${error.code}` : status));
  return { camera, time, video, media, doc, wakeLock, bitmaps, statuses };
}