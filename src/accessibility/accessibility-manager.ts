/**
 * Cụm điều khiển trợ năng (F3): nút "Nghe lại kết quả", nút "Bật đèn" (aria-pressed), nút "Cài đặt",
 * cùng vùng trạng thái chữ to cho người nhược thị.
 *
 * LƯU Ý NỀN TẢNG: khi TalkBack hoặc VoiceOver bật, chạm một lần chỉ là khám phá, chạm hai lần mới kích hoạt;
 * bộ lắng nghe cử chỉ tự viết sẽ không nhận được chạm đơn. Vì vậy mọi thao tác đi qua button thật (sự kiện click),
 * không dùng touchstart/pointerdown. Thứ tự focus chính là thứ tự DOM (không dùng tabindex dương): cụm này được
 * chèn ĐẦU root, nên "Nghe lại kết quả" luôn là phần tử focus được đầu tiên, rồi "Bật đèn", rồi "Cài đặt".
 *
 * Quy ước phối hợp với P11 và settings-manager:
 * - Chữ to và tương phản cao đến từ biến CSS trên <html> do settings-manager đặt: --font-scale, --a11y-fg,
 *   --a11y-bg, --a11y-border-width (đều có giá trị dự phòng ở đây).
 * - Vùng trạng thái mặc định aria-hidden="true" để KHÔNG bị đọc đè lên giọng của app. Chỉ khi <html> có
 *   data-speech-output="SCREEN_READER" (settings-manager ghi) nó mới thành aria-live="polite" và hết ẩn.
 * - Không dùng màu làm thông tin duy nhất: nút đèn có chữ "Đang bật/Đang tắt" và biểu tượng hình khác nhau (● / ○).
 */
import { MIN_TARGET_PX, ROLE_ATTR, SPEECH_OUTPUT_ATTR, roleSelector, safeCall, setStyles } from './a11y-shared';
import type { A11yRole } from './a11y-shared';

export const APP_TITLE = 'Nhận dạng tiền';
export const LABEL_REPLAY = 'Nghe lại kết quả';
export const LABEL_TORCH = 'Bật đèn';
export const LABEL_SETTINGS = 'Cài đặt';
const GROUP_LABEL = 'Điều khiển trợ năng';

const BUTTON_STYLES: Readonly<Record<string, string>> = {
  display: 'flex', 'align-items': 'center', 'justify-content': 'center', gap: '0.5rem', cursor: 'pointer',
  'min-width': `${MIN_TARGET_PX}px`, 'min-height': `${MIN_TARGET_PX}px`, padding: '0.5rem 1rem', 'border-radius': '0.5rem',
  border: 'var(--a11y-border-width, 2px) solid var(--a11y-fg, #ffffff)',
  background: 'var(--a11y-bg, #202124)', color: 'var(--a11y-fg, #ffffff)',
  'font-family': 'inherit', 'font-weight': '600', 'font-size': 'calc(1rem * var(--font-scale, 1))',
};
const GROUP_STYLES: Readonly<Record<string, string>> = { display: 'flex', 'flex-wrap': 'wrap', gap: '0.5rem', padding: '0.5rem' };
const STATUS_STYLES: Readonly<Record<string, string>> = {
  padding: '0.5rem 1rem', 'text-align': 'center', 'font-weight': '700',
  color: 'var(--a11y-fg, #ffffff)', 'font-size': 'calc(1.5rem * var(--font-scale, 1))',
};

function makeSpan(doc: Document, text: string, decorative: boolean): HTMLSpanElement {
  const span = doc.createElement('span');
  span.textContent = text;
  if (decorative) span.setAttribute('aria-hidden', 'true'); // biểu tượng/trạng thái trang trí: nhãn của nút đã đủ nghĩa
  return span;
}

interface Control { button: HTMLButtonElement; icon: HTMLSpanElement }

/** Bốn phương thức đúng theo bảng đăng ký, cộng setTorchSupported (phụ, xem ghi chú ở dưới). */
export interface AccessibilityManager {
  /** Phản ánh trạng thái đèn THẬT (gọi sau khi camera/đèn đã đổi): cập nhật aria-pressed, chữ và biểu tượng. */
  setTorchPressed(on: boolean): void;
  /** Ghi chữ vào vùng trạng thái hiển thị. */
  setStatusText(t: string): void;
  /** Đưa focus về nút "Nghe lại kết quả". */
  focusReplay(): void;
  dispose(): void;
  /**
   * PHỤ: ẩn/hiện nút đèn sau khi dựng. Cần vì camera.torchSupported thường chỉ biết sau khi camera chạy,
   * trong khi cụm trợ năng phải có từ lúc mở app.
   */
  setTorchSupported(supported: boolean): void;
}

function makeControl(doc: Document, role: A11yRole, label: string, icon: string, onClick: () => void): Control {
  const button = doc.createElement('button');
  button.type = 'button';
  button.setAttribute(ROLE_ATTR, role);
  button.setAttribute('aria-label', label);
  setStyles(button, BUTTON_STYLES);
  const iconSpan = makeSpan(doc, icon, true);
  button.append(iconSpan, makeSpan(doc, label, false));
  button.addEventListener('click', () => safeCall(label, onClick));
  return { button, icon: iconSpan };
}

export function createAccessibilityManager(
  o: { root: HTMLElement; torchSupported: boolean; onReplay: () => void; onToggleTorch: () => void; onOpenSettings: () => void },
): AccessibilityManager {
  const doc = o.root.ownerDocument;
  const html = doc.documentElement;
  let disposed = false;
  let torchOn = false;

  // Ngôn ngữ trang: để trình đọc màn hình chọn giọng tiếng Việt.
  html.setAttribute('lang', 'vi');
  doc.title = APP_TITLE;
  doc.querySelector('title')?.setAttribute('lang', 'vi');

  // Gọi hai lần không được sinh hai cụm (sẽ có hai nút "Nghe lại kết quả").
  for (const old of o.root.querySelectorAll(`${roleSelector('controls')}, ${roleSelector('status')}`)) old.remove();

  const group = doc.createElement('div');
  group.setAttribute(ROLE_ATTR, 'controls');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', GROUP_LABEL);
  setStyles(group, GROUP_STYLES);

  const replay = makeControl(doc, 'replay', LABEL_REPLAY, '↻', o.onReplay);
  const settings = makeControl(doc, 'settings', LABEL_SETTINGS, '≡', o.onOpenSettings);
  const torch = makeControl(doc, 'torch', LABEL_TORCH, '○', o.onToggleTorch);
  const torchState = makeSpan(doc, '', true);
  torch.button.append(torchState);
  group.append(replay.button, settings.button);

  const status = doc.createElement('div');
  status.setAttribute(ROLE_ATTR, 'status');
  setStyles(status, STATUS_STYLES);

  function renderTorch(): void {
    torch.button.setAttribute('aria-pressed', String(torchOn));
    torch.button.setAttribute('data-pressed', String(torchOn));
    torch.icon.textContent = torchOn ? '●' : '○';
    torchState.textContent = torchOn ? 'Đang bật' : 'Đang tắt';
  }

  /** Nút đèn chỉ có trong DOM khi thiết bị hỗ trợ; luôn nằm giữa "Nghe lại kết quả" và "Cài đặt". */
  function setTorchSupported(supported: boolean): void {
    if (disposed) return;
    if (!supported) torch.button.remove();
    else if (torch.button.parentNode === null) replay.button.after(torch.button);
  }

  function applyStatusMode(): void {
    const screenReader = html.getAttribute(SPEECH_OUTPUT_ATTR) === 'SCREEN_READER';
    if (screenReader) {
      status.removeAttribute('aria-hidden');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
    } else {
      status.setAttribute('aria-hidden', 'true');
      status.removeAttribute('aria-live');
      status.removeAttribute('aria-atomic');
    }
  }

  renderTorch();
  setTorchSupported(o.torchSupported);
  applyStatusMode();
  o.root.prepend(group, status);

  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(applyStatusMode);
  observer?.observe(html, { attributes: true, attributeFilter: [SPEECH_OUTPUT_ATTR] });

  return {
    setTorchPressed(on: boolean): void {
      torchOn = on;
      renderTorch();
    },
    setTorchSupported,
    setStatusText(t: string): void {
      applyStatusMode(); // đọc lại chế độ ngay lúc ghi, phòng khi quan sát thuộc tính chưa kịp chạy
      status.textContent = t;
    },
    focusReplay(): void {
      replay.button.focus({ preventScroll: true });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      group.remove();
      status.remove();
    },
  };
}