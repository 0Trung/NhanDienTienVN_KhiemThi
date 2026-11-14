import type { ITorchPort } from '../contracts';
import { createLogger } from '../utils/logger';
import { INSECURE_CONTEXT_MESSAGE, createCameraError, isOverconstrainedError, mapCameraError } from './camera-errors';

const log = createLogger('camera:service');

/** Nhãn ống kính phụ: không được ưu tiên khi chọn camera chính (F5). */
const SECONDARY_LENS = /ultra|wide|tele|macro|depth/i;
const BACK_FACING = /back|rear|environment/i;
const IDEAL_SIZE = { width: { ideal: 1280 }, height: { ideal: 720 } };
const IDEAL_FPS = { frameRate: { ideal: 30 } };
const FACING_BACK = { facingMode: { ideal: 'environment' } };

/** Phần của navigator.mediaDevices mà module dùng (tiêm đồ giả khi test). */
export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices?(): Promise<MediaDeviceInfo[]>;
}

/** Khả năng và ràng buộc ngoài chuẩn lib.dom (Image Capture). */
interface TrackCapabilitiesExt { torch?: boolean; focusMode?: readonly string[] }
type ConstraintSetExt = MediaTrackConstraintSet & { torch?: boolean; focusMode?: string };

/** Chuỗi ràng buộc, hạ dần khi gặp OverconstrainedError (F1): đủ → bỏ độ phân giải → bỏ cả facingMode. audio luôn false. */
export const CONSTRAINT_STEPS: ReadonlyArray<MediaStreamConstraints> = [
  { audio: false, video: { ...FACING_BACK, ...IDEAL_SIZE, ...IDEAL_FPS } },
  { audio: false, video: { ...FACING_BACK, ...IDEAL_FPS } },
  { audio: false, video: { ...IDEAL_FPS } },
];

/**
 * Chọn camera sau chính (F5). Trả về deviceId cần chuyển sang, hoặc null nếu không cần chuyển:
 * nhãn rỗng (chưa có quyền), chưa đủ 2 camera sau, hoặc camera đang dùng không phải ống kính phụ.
 */
export function pickMainBackCamera(devices: readonly MediaDeviceInfo[], currentDeviceId?: string): string | null {
  const back = devices.filter((d) => d.kind === 'videoinput' && d.label !== '' && BACK_FACING.test(d.label));
  if (back.length < 2) return null;
  const main = back.find((d) => !SECONDARY_LENS.test(d.label));
  const current = back.find((d) => d.deviceId === currentDeviceId);
  return main && current && SECONDARY_LENS.test(current.label) ? main.deviceId : null;
}

/**
 * Cấu hình thẻ video: playsinline, muted, autoplay; aria-hidden để trình đọc màn hình không bắt focus;
 * kiểu hiển thị phủ kín khung chứa. Việc gắn thẻ vào DOM là của nơi dùng (P11).
 */
export function prepareVideoElement(video: HTMLVideoElement): void {
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  for (const [name, value] of [['muted', ''], ['autoplay', ''], ['playsinline', ''], ['aria-hidden', 'true']] as const) {
    video.setAttribute(name, value);
  }
  Object.assign(video.style, { display: 'block', width: '100%', height: '100%', objectFit: 'cover' });
}

/** Gắn stream vào thẻ video và chờ phát. play() lỗi thì ném CAMERA_FAILED. */
export async function attachStream(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  prepareVideoElement(video);
  video.srcObject = stream;
  try {
    await video.play();
  } catch (err) {
    throw createCameraError('CAMERA_FAILED', err);
  }
}

/** Gỡ stream khỏi thẻ video (việc dừng track là của CameraSource.close). */
export function detachStream(video: HTMLVideoElement): void {
  try {
    video.pause();
  } catch (err) {
    log.debug('video.pause() lỗi khi gỡ stream', err);
  }
  video.srcObject = null;
}

function stopStream(stream: MediaStream | null): void {
  for (const t of stream?.getTracks() ?? []) t.stop();
}

export interface CameraSourceDeps {
  /** navigator.mediaDevices (undefined khi ngữ cảnh không an toàn hoặc trình duyệt cũ). */
  mediaDevices: MediaDevicesLike | undefined;
  /** window.isSecureContext; undefined nghĩa là không biết, không chặn. */
  isSecureContext: boolean | undefined;
  torchPort?: ITorchPort;
  /** Gọi khi track video kết thúc ngoài ý muốn (app khác chiếm camera, rút camera). */
  onEnded: () => void;
}

export interface CameraSource {
  /** Xin quyền, mở camera sau, chọn camera chính, lấy nét liên tục, dò đèn. Ném AppError. */
  open(): Promise<MediaStream>;
  /** Dừng mọi track, tắt đèn qua cổng nếu cần. Gọi nhiều lần an toàn. */
  close(): void;
  /** Track video còn sống (readyState live). */
  isLive(): boolean;
  readonly torchSupported: boolean;
  /** true nếu bật/tắt được; không hỗ trợ hoặc lỗi thì false, không ném. */
  setTorch(on: boolean): Promise<boolean>;
}

type TorchMode = 'track' | 'port' | 'none';

export function createCameraSource(deps: CameraSourceDeps): CameraSource {
  const port = deps.torchPort;
  let stream: MediaStream | null = null;
  let track: MediaStreamTrack | null = null;
  let torchMode: TorchMode = 'none';
  let torchOn = false;

  function checkSupport(): MediaDevicesLike {
    if (deps.isSecureContext === false) {
      throw createCameraError('UNSUPPORTED_BROWSER', 'INSECURE_CONTEXT', INSECURE_CONTEXT_MESSAGE);
    }
    const md = deps.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') throw createCameraError('UNSUPPORTED_BROWSER', 'NO_MEDIA_DEVICES');
    return md;
  }

  /** getUserMedia với chuỗi hạ ràng buộc; chỉ hạ khi gặp OverconstrainedError. */
  async function acquire(md: MediaDevicesLike): Promise<MediaStream> {
    let lastError: unknown;
    for (const [step, constraints] of CONSTRAINT_STEPS.entries()) {
      try {
        return await md.getUserMedia(constraints);
      } catch (err) {
        if (!isOverconstrainedError(err)) throw mapCameraError(err);
        log.warn(`Ràng buộc bước ${step} không thoả, hạ xuống bước kế`, err);
        lastError = err;
      }
    }
    throw mapCameraError(lastError);
  }

  /** Có nhiều camera sau thì chuyển sang camera chính. Lỗi ở bước chọn thì giữ stream hiện có. */
  async function preferMainCamera(md: MediaDevicesLike, current: MediaStream): Promise<MediaStream> {
    let targetId: string | null = null;
    try {
      const currentId = current.getVideoTracks()[0]?.getSettings().deviceId;
      if (md.enumerateDevices) targetId = pickMainBackCamera(await md.enumerateDevices(), currentId);
    } catch (err) {
      log.warn('Không liệt kê được camera, giữ camera mặc định', err);
    }
    if (targetId === null) return current;
    stopStream(current); // một số máy không mở được hai luồng cùng lúc
    try {
      return await md.getUserMedia({ audio: false, video: { deviceId: { exact: targetId }, ...IDEAL_SIZE, ...IDEAL_FPS } });
    } catch (err) {
      log.warn('Không mở được camera chính, quay về camera mặc định', err);
      return acquire(md);
    }
  }

  function readCapabilities(t: MediaStreamTrack): TrackCapabilitiesExt | undefined {
    try {
      return typeof t.getCapabilities === 'function' ? (t.getCapabilities() as unknown as TrackCapabilitiesExt) : undefined;
    } catch {
      return undefined;
    }
  }

  async function applyContinuousFocus(t: MediaStreamTrack): Promise<void> {
    if (readCapabilities(t)?.focusMode?.includes('continuous') !== true) return;
    const focus: ConstraintSetExt = { focusMode: 'continuous' };
    try {
      await t.applyConstraints({ advanced: [focus] });
    } catch (err) {
      log.warn('Không bật được lấy nét liên tục', err);
    }
  }

  /** Đèn: ưu tiên getUserMedia (capabilities.torch); không có thì hỏi cổng dự phòng. */
  async function detectTorch(t: MediaStreamTrack): Promise<TorchMode> {
    if (readCapabilities(t)?.torch === true) return 'track';
    try {
      if (port && (await port.isSupported())) return 'port';
    } catch (err) {
      log.warn('Cổng đèn dự phòng báo lỗi khi dò', err);
    }
    return 'none';
  }

  function close(): void {
    if (torchMode === 'port' && torchOn && port) void port.set(false).catch(() => undefined);
    if (track) track.onended = null;
    stopStream(stream);
    stream = null;
    track = null;
    torchMode = 'none';
    torchOn = false;
  }

  async function open(): Promise<MediaStream> {
    const md = checkSupport();
    close();
    let next = await acquire(md);
    try {
      next = await preferMainCamera(md, next);
      const videoTrack = next.getVideoTracks()[0];
      if (!videoTrack) throw createCameraError('CAMERA_FAILED', 'NO_VIDEO_TRACK');
      stream = next;
      track = videoTrack;
      await applyContinuousFocus(videoTrack);
      torchMode = await detectTorch(videoTrack);
      if (videoTrack.readyState === 'ended') throw createCameraError('CAMERA_IN_USE', 'ENDED_WHILE_OPENING');
      videoTrack.onended = () => {
        if (track === videoTrack) deps.onEnded();
      };
      return next;
    } catch (err) {
      stopStream(next);
      close();
      throw mapCameraError(err);
    }
  }

  async function setTorch(on: boolean): Promise<boolean> {
    if (torchMode === 'none' || track === null) return false;
    let ok = false;
    try {
      if (torchMode === 'track') {
        const torch: ConstraintSetExt = { torch: on };
        await track.applyConstraints({ advanced: [torch] });
        ok = true;
      } else if (port) {
        ok = await port.set(on);
      }
    } catch (err) {
      log.warn('Không điều khiển được đèn', err);
    }
    if (ok) torchOn = on;
    return ok;
  }

  return {
    open,
    close,
    isLive: () => track !== null && track.readyState === 'live',
    get torchSupported(): boolean {
      return torchMode !== 'none';
    },
    setTorch,
  };
}