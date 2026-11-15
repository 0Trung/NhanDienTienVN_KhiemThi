/**
 * Cử chỉ trên bề mặt camera (F2): chạm = nghe lại kết quả; giữ 600 ms = bật/tắt đèn.
 *
 * LƯU Ý NỀN TẢNG: khi TalkBack hoặc VoiceOver bật, chạm một lần chỉ là khám phá, chạm hai lần mới kích hoạt;
 * bộ lắng nghe cử chỉ tự viết sẽ không nhận được chạm đơn. Vì vậy cử chỉ này CHỈ là đường tắt cho người dùng
 * không bật trình đọc màn hình. Mọi thao tác đều phải làm được bằng button thật (xem accessibility-manager):
 * nút "Nghe lại kết quả" DUY NHẤT, nằm đầu thứ tự focus, do accessibility-manager dựng; controller này
 * không dựng thêm nút nào để không trùng nhãn.
 *
 * Cách làm: dùng Pointer Events; hủy khi ngón di chuyển quá ngưỡng hoặc có ngón thứ hai. Chống kích hoạt kép:
 * sau pointerup trình duyệt còn bắn thêm sự kiện click, nên click đó bị bỏ qua trong CLICK_SWALLOW_MS. Click "thuần"
 * (không có pointer đi trước, ví dụ trình đọc màn hình kích hoạt phần tử) vẫn được coi là một lần chạm.
 */
import { safeCall } from './a11y-shared';

/** Giữ đủ lâu thì bật/tắt đèn (ms). */
export const HOLD_MS = 600;
/** Ngón di chuyển quá khoảng này (px) thì không còn là chạm/giữ. */
export const MOVE_TOLERANCE_PX = 10;
/** Thời gian bỏ qua click đi kèm một cử chỉ pointer vừa xử lý (ms). */
export const CLICK_SWALLOW_MS = 400;

type Timer = ReturnType<typeof setTimeout>;
interface Press { id: number; x: number; y: number; invalid: boolean; holdFired: boolean; timer: Timer | null }

export function createGestureController(
  o: { surface: HTMLElement; onReplay: () => void; onToggleTorch: () => void },
): { dispose(): void } {
  const { surface } = o;
  const cleanups: Array<() => void> = [];
  let press: Press | null = null;
  let swallowClick = false;
  let swallowTimer: Timer | null = null;
  let disposed = false;

  const stopHold = (p: Press): void => {
    if (p.timer !== null) clearTimeout(p.timer);
    p.timer = null;
  };
  const clearSwallow = (): void => {
    if (swallowTimer !== null) clearTimeout(swallowTimer);
    swallowTimer = null;
    swallowClick = false;
  };
  const swallowNextClick = (): void => {
    clearSwallow();
    swallowClick = true;
    swallowTimer = setTimeout(clearSwallow, CLICK_SWALLOW_MS);
  };
  const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (e: HTMLElementEventMap[K]) => void): void => {
    surface.addEventListener(type, handler);
    cleanups.push(() => surface.removeEventListener(type, handler));
  };

  on('pointerdown', (e) => {
    if (e.button !== 0) return; // chỉ chạm / bút / nút chính của chuột
    if (press !== null && press.id !== e.pointerId) { // ngón thứ hai: không còn là chạm đơn
      press.invalid = true;
      stopHold(press);
      return;
    }
    if (press !== null) stopHold(press);
    const current: Press = { id: e.pointerId, x: e.clientX, y: e.clientY, invalid: false, holdFired: false, timer: null };
    current.timer = setTimeout(() => {
      current.timer = null;
      if (press !== current || current.invalid) return;
      current.holdFired = true;
      safeCall('onToggleTorch', o.onToggleTorch);
    }, HOLD_MS);
    press = current;
  });

  on('pointermove', (e) => {
    if (press === null || press.id !== e.pointerId || press.invalid) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE_PX) {
      press.invalid = true; // kéo quá ngưỡng: hủy cả chạm lẫn giữ
      stopHold(press);
    }
  });

  on('pointerup', (e) => {
    if (press === null || press.id !== e.pointerId) return;
    const done = press;
    stopHold(done);
    press = null;
    swallowNextClick(); // click đi kèm (nếu có) không được tính lần hai
    if (!done.invalid && !done.holdFired) safeCall('onReplay', o.onReplay);
  });

  const cancel = (e: PointerEvent): void => {
    if (press === null || press.id !== e.pointerId) return;
    stopHold(press);
    press = null;
  };
  on('pointercancel', cancel);
  on('pointerleave', cancel); // chuột rời bề mặt khi đang giữ

  on('click', () => {
    if (swallowClick) {
      clearSwallow();
      return;
    }
    safeCall('onReplay', o.onReplay);
  });

  // Giữ lâu trên Android mở menu ngữ cảnh của hệ thống: chặn để không phá cử chỉ giữ.
  on('contextmenu', (e) => e.preventDefault());

  // touch-action: manipulation tắt phóng to bằng chạm đúp (nếu không, chạm hai lần để nghe lại sẽ phóng to trang).
  const previous = { touchAction: surface.style.getPropertyValue('touch-action'), userSelect: surface.style.getPropertyValue('user-select') };
  surface.style.setProperty('touch-action', 'manipulation');
  surface.style.setProperty('user-select', 'none');

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (press !== null) stopHold(press);
      press = null;
      clearSwallow();
      for (const undo of cleanups) undo();
      surface.style.setProperty('touch-action', previous.touchAction);
      surface.style.setProperty('user-select', previous.userSelect);
    },
  };
}