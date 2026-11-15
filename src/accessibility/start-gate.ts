/**
 * Cổng khởi động (F1): MỘT button toàn màn hình, nhãn "Bắt đầu nhận dạng tiền. Chạm hai lần để bắt đầu."
 *
 * VÌ SAO CẦN CỔNG NÀY
 * - Trình duyệt/WebView chỉ cho phát tiếng (Web Speech, mp3) sau MỘT thao tác của người dùng (chính sách autoplay).
 *   App này lấy giọng nói làm kênh chính nên câu chào đầu tiên cũng phải được phát. Cổng tạo ra đúng một sự kiện
 *   click có chủ đích, và unlock() được gọi NGAY TRONG sự kiện đó thì engine mới được "mở khóa".
 * - P11 chỉ hiện cổng khi TtsCapabilities.requiresUserGesture là true. Trên APK với giọng native không có chính sách
 *   này nên app tự bắt đầu, không hiện cổng.
 *
 * LƯU Ý NỀN TẢNG: khi TalkBack hoặc VoiceOver bật, chạm một lần chỉ là khám phá, chạm hai lần mới kích hoạt;
 * bộ lắng nghe cử chỉ tự viết (touchstart, pointerdown) không nhận được chạm đơn. Vì vậy cổng là button thật và
 * chỉ lắng nghe sự kiện click (Enter/Space và chạm hai lần của trình đọc màn hình đều sinh ra click).
 *
 * Thứ tự khi kích hoạt (chỉ chạy một lần): unlock() → onStart() → gỡ cổng → chuyển focus sang nút "Nghe lại kết quả".
 * Nên dựng cụm trợ năng (accessibility-manager) trước khi show() để cổng nằm đầu thứ tự đọc.
 */
import { roleSelector, ROLE_ATTR, safeCall, setStyles } from './a11y-shared';

/** Nhãn đọc của cổng (trình đọc màn hình đọc nguyên câu này). */
export const START_GATE_LABEL = 'Bắt đầu nhận dạng tiền. Chạm hai lần để bắt đầu.';
const TITLE_TEXT = 'Bắt đầu nhận dạng tiền';
const HINT_TEXT = 'Chạm hai lần để bắt đầu';

const GATE_STYLES: Readonly<Record<string, string>> = {
  position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', 'z-index': '1000',
  display: 'flex', 'flex-direction': 'column', 'align-items': 'center', 'justify-content': 'center', gap: '1rem',
  margin: '0', padding: '1rem', 'box-sizing': 'border-box', cursor: 'pointer', 'text-align': 'center',
  border: 'var(--a11y-border-width, 4px) solid var(--a11y-fg, #ffffff)',
  background: 'var(--a11y-bg, #000000)', color: 'var(--a11y-fg, #ffffff)',
  'font-family': 'inherit', 'font-weight': '700', 'font-size': 'calc(1.75rem * var(--font-scale, 1))',
};

export function createStartGate(o: { root: HTMLElement; onStart: () => void; unlock: () => void }): { show(): void; hide(): void } {
  const doc = o.root.ownerDocument;
  let gate: HTMLButtonElement | null = null;
  let started = false;
  let inerted: Element[] = [];

  function focusReplay(): void {
    const selector = roleSelector('replay');
    const replay = o.root.querySelector<HTMLElement>(selector) ?? doc.querySelector<HTMLElement>(selector);
    replay?.focus({ preventScroll: true });
  }

  /** Khi cổng hiện, phần còn lại của app không được focus/đọc được (tránh lướt vào nút nằm dưới cổng). */
  function setInert(on: boolean): void {
    if (!on) {
      for (const el of inerted) el.removeAttribute('inert');
      inerted = [];
      return;
    }
    // Không làm inert vùng aria-live: giọng đọc qua trình đọc màn hình vẫn phải đến được người dùng.
    inerted = Array.from(o.root.children).filter(
      (el) => el !== gate && !el.hasAttribute('inert') && !el.hasAttribute('aria-live'),
    );
    for (const el of inerted) el.setAttribute('inert', '');
  }

  function close(forceFocus: boolean): void {
    if (gate === null) return;
    const active = doc.activeElement;
    const hadFocus = forceFocus || active === null || active === doc.body || gate.contains(active);
    setInert(false);
    gate.remove();
    gate = null;
    if (hadFocus) focusReplay();
  }

  function activate(): void {
    if (started) return; // chỉ một lần: chạm đúp, kích hoạt lặp của trình đọc màn hình
    started = true;
    safeCall('unlock', o.unlock); // 1. ngay trong sự kiện click, để qua chính sách autoplay
    safeCall('onStart', o.onStart); // 2. app bắt đầu (giọng chào, xin quyền camera...)
    close(true); // 3. gỡ cổng, 4. chuyển focus sang nút nghe lại
  }

  function show(): void {
    if (started || gate !== null) return;
    const button = doc.createElement('button');
    button.type = 'button';
    button.lang = 'vi';
    button.setAttribute(ROLE_ATTR, 'start-gate');
    button.setAttribute('aria-label', START_GATE_LABEL);
    setStyles(button, GATE_STYLES);
    for (const [text, size] of [[TITLE_TEXT, '1'], [HINT_TEXT, '0.7']] as const) {
      const line = doc.createElement('span');
      line.textContent = text;
      line.style.setProperty('font-size', `${size}em`);
      button.append(line);
    }
    button.addEventListener('click', activate);
    gate = button;
    o.root.prepend(button);
    setInert(true);
    button.focus({ preventScroll: true }); // TalkBack/VoiceOver đọc nhãn ngay khi cổng hiện
  }

  return { show, hide: () => close(false) };
}