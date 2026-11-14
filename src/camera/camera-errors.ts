import { AppError } from '../contracts';
import type { AppErrorCode } from '../contracts';

/** Các mã lỗi mà module camera có thể tạo ra. */
export type CameraErrorCode = Extract<
  AppErrorCode,
  'UNSUPPORTED_BROWSER' | 'CAMERA_PERMISSION_DENIED' | 'CAMERA_NOT_FOUND' | 'CAMERA_IN_USE' | 'CAMERA_FAILED'
>;

/** Thông điệp tiếng Việt nói rõ việc cần làm. fatal = true khi tự thử lại vô ích, người dùng phải can thiệp ngoài ứng dụng. */
const ERROR_INFO: Readonly<Record<CameraErrorCode, { message: string; fatal: boolean }>> = {
  UNSUPPORTED_BROWSER: {
    fatal: true,
    message: 'Thiết bị này chưa hỗ trợ dùng camera trong ứng dụng. Hãy cập nhật Android System WebView hoặc Chrome rồi mở lại ứng dụng.',
  },
  CAMERA_PERMISSION_DENIED: {
    fatal: true,
    message: 'Ứng dụng chưa được phép dùng camera. Hãy vào Cài đặt, chọn Ứng dụng, chọn ứng dụng này, bật quyền Camera rồi mở lại.',
  },
  CAMERA_NOT_FOUND: {
    fatal: true,
    message: 'Không tìm thấy camera trên thiết bị. Hãy kiểm tra camera có bị hỏng hoặc bị che không rồi mở lại ứng dụng.',
  },
  CAMERA_IN_USE: {
    fatal: false,
    message: 'Camera đang được ứng dụng khác sử dụng. Hãy đóng các ứng dụng đang dùng camera, kết thúc cuộc gọi video nếu có, rồi thử lại.',
  },
  CAMERA_FAILED: {
    fatal: false,
    message: 'Không mở được camera. Hãy đóng hẳn ứng dụng rồi mở lại; nếu vẫn lỗi thì hãy khởi động lại điện thoại.',
  },
};

/** Thông điệp riêng cho ngữ cảnh không an toàn (mã UNSUPPORTED_BROWSER). */
export const INSECURE_CONTEXT_MESSAGE =
  'Camera chỉ dùng được trên kết nối an toàn (https hoặc localhost). Hãy mở ứng dụng qua địa chỉ https.';

/** Tên lỗi DOM → mã lỗi ứng dụng (F2). Dùng Map để tên như "constructor" không bị coi là khoá có sẵn. */
const NAME_TO_CODE: ReadonlyMap<string, CameraErrorCode> = new Map<string, CameraErrorCode>([
  ['NotAllowedError', 'CAMERA_PERMISSION_DENIED'],
  ['SecurityError', 'CAMERA_PERMISSION_DENIED'],
  ['NotFoundError', 'CAMERA_NOT_FOUND'],
  ['DevicesNotFoundError', 'CAMERA_NOT_FOUND'],
  ['NotReadableError', 'CAMERA_IN_USE'],
  ['TrackStartError', 'CAMERA_IN_USE'],
]);

/** Đọc `name` của một giá trị bị ném ra bất kỳ; không phải đối tượng có name dạng chuỗi thì trả chuỗi rỗng. */
export function errorName(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name : '';
}

/** Lỗi "ràng buộc không thoả" (tên mới và tên cũ của trình duyệt). */
export function isOverconstrainedError(err: unknown): boolean {
  const name = errorName(err);
  return name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError';
}

/** Tạo AppError camera với thông điệp tiếng Việt chuẩn; `message` chỉ để ghi đè trường hợp đặc biệt. */
export function createCameraError(code: CameraErrorCode, detail?: unknown, message?: string): AppError {
  const info = ERROR_INFO[code];
  return new AppError(code, message ?? info.message, info.fatal, detail);
}

/** Ánh xạ mọi giá trị bị ném ra từ API camera sang AppError (F2). AppError có sẵn được giữ nguyên. */
export function mapCameraError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return createCameraError(NAME_TO_CODE.get(errorName(err)) ?? 'CAMERA_FAILED', err);
}