/**
 * Màn lỗi: thông điệp theo mã lỗi và một nút "Thử lại" có nhãn. Lời nói đã nói lỗi từ trước (app.ts); màn này dành cho
 * người nhược thị và người giúp đỡ nên KHÔNG tự đọc (không aria-live): chỉ chuyển focus tới tiêu đề để trình đọc màn
 * hình đọc "Có lỗi", rồi người dùng lướt tới thông điệp và nút.
 */
import type { AppErrorCode } from '../contracts';

export const ERROR_TITLE = 'Có lỗi';
export const RETRY_LABEL = 'Thử lại';

/** Đủ mọi mã lỗi (Record bắt buộc đủ khóa). Nội dung khớp với câu đã đọc, thêm tên nút "Thử lại". */
export const ERROR_MESSAGES: Readonly<Record<AppErrorCode, string>> = {
  UNSUPPORTED_BROWSER: 'Điện thoại chưa hỗ trợ đủ tính năng cần thiết. Hãy cập nhật WebView trong cửa hàng ứng dụng rồi mở lại ứng dụng.',
  CAMERA_PERMISSION_DENIED: 'Bạn chưa cấp quyền camera. Hãy mở Cài đặt của điện thoại, chọn Ứng dụng, chọn ứng dụng này rồi bật quyền Camera.',
  CAMERA_NOT_FOUND: 'Không tìm thấy camera trên điện thoại. Hãy thử lại trên một điện thoại có camera sau.',
  CAMERA_IN_USE: 'Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi bấm Thử lại.',
  CAMERA_FAILED: 'Không mở được camera. Hãy bấm Thử lại, nếu vẫn lỗi thì đóng ứng dụng rồi mở lại.',
  MODEL_MISSING: 'Ứng dụng thiếu dữ liệu nhận dạng. Hãy cài lại ứng dụng.',
  MODEL_CORRUPT: 'Dữ liệu nhận dạng bị hỏng. Hãy cài lại ứng dụng.',
  MODEL_INIT_FAILED: 'Không khởi động được bộ nhận dạng. Hãy bấm Thử lại, nếu vẫn lỗi thì đóng ứng dụng rồi mở lại.',
  INFERENCE_FAILED: 'Nhận dạng gặp lỗi. Hãy bấm Thử lại, nếu vẫn lỗi thì đóng ứng dụng rồi mở lại.',
  TTS_UNAVAILABLE: 'Giọng đọc của điện thoại đang không hoạt động. Hãy kiểm tra mục Chuyển văn bản thành giọng nói trong Cài đặt rồi bấm Thử lại.',
  TTS_NO_VIETNAMESE_VOICE: 'Điện thoại chưa có giọng đọc tiếng Việt. Hãy vào Cài đặt, Chuyển văn bản thành giọng nói, rồi tải dữ liệu giọng Tiếng Việt.',
  STORAGE_FAILED: 'Không lưu được cài đặt. Hãy kiểm tra bộ nhớ điện thoại còn trống rồi bấm Thử lại.',
  OFFLINE_NOT_READY: 'Ứng dụng thiếu dữ liệu nhận dạng. Hãy cài lại ứng dụng.',
};

export interface ErrorScreen {
  readonly el: HTMLElement;
  show(e: { code: AppErrorCode; detail?: string }): void;
  hide(): void;
  dispose(): void;
}

export function createErrorScreen(o: { doc: Document; onRetry: () => void; showDetail?: boolean }): ErrorScreen {
  const { doc } = o;
  const el = doc.createElement('section');
  el.className = 'screen error-screen';
  el.hidden = true;
  el.setAttribute('aria-labelledby', 'error-title');

  const title = doc.createElement('h1');
  title.id = 'error-title';
  title.tabIndex = -1;
  title.textContent = ERROR_TITLE;
  const message = doc.createElement('p');
  message.className = 'error-message';
  const detail = doc.createElement('p');
  detail.className = 'error-detail'; // chi tiết kỹ thuật: chỉ hiện ở bản debug
  detail.hidden = true;
  const retry = doc.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-primary';
  retry.setAttribute('aria-label', RETRY_LABEL);
  retry.textContent = RETRY_LABEL;
  retry.addEventListener('click', o.onRetry);
  el.append(title, message, detail, retry);

  return {
    el,
    show({ code, detail: text }) {
      message.textContent = ERROR_MESSAGES[code];
      detail.textContent = `${code}${text === undefined ? '' : `: ${text}`}`;
      detail.hidden = o.showDetail !== true;
      el.hidden = false;
      title.focus({ preventScroll: true });
    },
    hide: () => void (el.hidden = true),
    dispose: () => el.remove(),
  };
}