/**
 * Hằng số và hàm nhỏ dùng chung trong module trợ năng (P10).
 * Chỉ phụ thuộc logger của P00; các file P10 khác import từ đây thay vì import lẫn nhau.
 */
import { createLogger } from '../utils/logger';

const log = createLogger('accessibility');

/** Vai trò của các phần tử do module trợ năng dựng (ghi vào ROLE_ATTR để tìm lại, không dựa vào class). */
export type A11yRole = 'start-gate' | 'controls' | 'replay' | 'torch' | 'settings' | 'status' | 'live-region';

export const ROLE_ATTR = 'data-a11y';

/** Selector chọn phần tử theo vai trò, ví dụ roleSelector('replay'). */
export function roleSelector(role: A11yRole): string {
  return `[${ROLE_ATTR}="${role}"]`;
}

/**
 * Thuộc tính trên <html> ('APP_TTS' | 'SCREEN_READER'): settings-manager ghi, accessibility-manager đọc
 * để biết có được bật aria-live cho vùng trạng thái hay không (hai module không gọi nhau trực tiếp).
 */
export const SPEECH_OUTPUT_ATTR = 'data-speech-output';

/** Cạnh tối thiểu của vùng chạm (px), theo khuyến nghị 48 dp của Android. */
export const MIN_TARGET_PX = 48;

/** Gọi hàm phản hồi của bên ngoài; lỗi trong hàm đó chỉ được ghi log, không làm hỏng luồng sự kiện. */
export function safeCall(what: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    log.error(`Lỗi trong ${what}:`, error);
  }
}

/** Gán nhiều thuộc tính CSS (tên dạng gạch nối) lên inline style của phần tử. */
export function setStyles(el: HTMLElement, styles: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value);
}