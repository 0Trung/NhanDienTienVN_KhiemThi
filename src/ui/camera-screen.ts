/**
 * Màn camera: bề mặt video toàn màn hình (chạm = nghe lại, giữ = đèn), cụm nút và vùng trạng thái chữ to.
 * Nút và vùng trạng thái do createAccessibilityManager dựng (nút thật, có nhãn); cử chỉ do createGestureController
 * chỉ gắn lên bề mặt video, KHÔNG gắn lên cả màn để chạm vào nút không bị tính thành "nghe lại" lần hai.
 * Màn này không chứa logic nghiệp vụ: chỉ dựng DOM và hiện chữ do describeStatus tạo.
 */
import { createAccessibilityManager } from '../accessibility/accessibility-manager';
import { createGestureController } from '../accessibility/gesture-controller';
import type { AppView } from '../app/app';
import type { AppState, DecisionStatus } from '../contracts';

const STATE_TEXT: Readonly<Record<AppState, string>> = {
  INITIALIZING: 'Đang khởi động',
  AWAITING_START: 'Chạm để bắt đầu',
  WAITING_PERMISSION: 'Hãy cho phép dùng camera',
  LOADING_MODEL: 'Đang tải bộ nhận dạng',
  READY: 'Đưa tiền vào trước camera',
  NO_CANDIDATE: 'Chưa thấy tiền',
  DETECTING: 'Đang nhận dạng',
  UNCERTAIN: 'Chưa nhận rõ tờ tiền',
  OVERLAPPING: 'Các tờ tiền đang chồng nhau',
  STABILIZING: 'Giữ yên tờ tiền',
  RESULT_READY: 'Đã nhận dạng',
  SPEAKING: 'Đã nhận dạng',
  ERROR: 'Có lỗi',
};

const STATUS_TEXT: Readonly<Record<DecisionStatus, string>> = {
  NO_MONEY_CANDIDATE: 'Chưa thấy tiền',
  LOW_CONFIDENCE: 'Chưa nhận rõ tờ tiền',
  CLASS_CONFLICT: 'Chưa phân biệt được mệnh giá',
  OVERLAP: 'Các tờ tiền đang chồng nhau',
  PARTIAL_IN_FRAME: 'Tờ tiền chưa nằm trọn trong khung',
  TOO_FAR: 'Đưa tiền lại gần camera hơn',
  BLUR: 'Hình bị mờ, hãy giữ máy cho yên',
  LOW_LIGHT: 'Ánh sáng yếu',
  UNSTABLE: 'Giữ yên tờ tiền',
  MULTI_NOT_ALLOWED: 'Chỉ đưa từng tờ một',
  CONFIDENT_SINGLE: 'Đã nhận dạng',
  CONFIDENT_MULTI: 'Đã nhận dạng',
};

/**
 * Chữ cho vùng trạng thái. Chỉ hiện số tiền khi engine đang xác nhận kết quả (Fail Safe): khi tờ tiền đã rời khung
 * hay chưa chắc thì màn hình không được để lại tổng cũ như thể còn đúng.
 */
export function describeStatus(view: AppView): string {
  const { result } = view;
  const confirmed = view.state === 'SPEAKING' || view.state === 'RESULT_READY' || view.status === 'CONFIDENT_SINGLE' || view.status === 'CONFIDENT_MULTI';
  if (confirmed && result !== null) return result.count > 1 ? `${result.count} tờ, tổng ${result.formattedTotal}` : result.formattedTotal;
  return view.status !== null ? STATUS_TEXT[view.status] : STATE_TEXT[view.state];
}

export interface CameraScreen {
  readonly el: HTMLElement;
  /** Bề mặt chứa video (và lớp vẽ debug); nhận cử chỉ. */
  readonly surface: HTMLElement;
  /** Lớp phủ chứa cụm nút, vùng trạng thái (và bảng debug). */
  readonly overlay: HTMLElement;
  readonly video: HTMLVideoElement;
  setStatusText(text: string): void;
  setTorch(t: { supported: boolean; on: boolean }): void;
  focusReplay(): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

export function createCameraScreen(o: { doc: Document; onReplay: () => void; onToggleTorch: () => void; onOpenSettings: () => void }): CameraScreen {
  const { doc } = o;
  const el = doc.createElement('main');
  el.className = 'screen camera-screen';
  el.setAttribute('aria-label', 'Màn hình camera');

  const surface = doc.createElement('div');
  surface.className = 'camera-surface';
  const video = doc.createElement('video');
  video.className = 'camera-video';
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.tabIndex = -1;
  video.setAttribute('aria-hidden', 'true'); // hình ảnh không có ý nghĩa với trình đọc màn hình
  surface.append(video);

  const overlay = doc.createElement('div');
  overlay.className = 'camera-overlay';
  el.append(surface, overlay);

  const a11y = createAccessibilityManager({ root: overlay, torchSupported: false, onReplay: o.onReplay, onToggleTorch: o.onToggleTorch, onOpenSettings: o.onOpenSettings });
  const gestures = createGestureController({ surface, onReplay: o.onReplay, onToggleTorch: o.onToggleTorch });
  let lastText: string | null = null;

  return {
    el, surface, overlay, video,
    setStatusText(text) {
      // Mỗi khung hình đều gọi vào đây: chỉ ghi khi chữ đổi, kẻo vùng trực tiếp (aria-live) bị đọc lặp liên tục.
      if (text === lastText) return;
      lastText = text;
      a11y.setStatusText(text);
    },
    setTorch: (t) => {
      a11y.setTorchSupported(t.supported); // chỉ biết sau khi camera chạy, nên không đặt lúc dựng
      a11y.setTorchPressed(t.on);
    },
    focusReplay: () => a11y.focusReplay(),
    show: () => void (el.hidden = false),
    hide: () => void (el.hidden = true),
    dispose: () => {
      gestures.dispose();
      a11y.dispose();
      el.remove();
    },
  };
}