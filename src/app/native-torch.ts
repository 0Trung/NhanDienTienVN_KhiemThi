/**
 * Cổng đèn pin native: đường dự phòng khi getUserMedia không điều khiển được đèn trong WebView (camera-service dò
 * capabilities.torch trước, chỉ hỏi cổng này khi track không có đèn).
 *
 * CHƯA CÀI. P11 không dám chắc tên và API của một plugin Capacitor 7 điều khiển đèn pin còn được duy trì và đã kiểm
 * chứng trên máy thật, mà Khối A cấm thêm thư viện runtime ngoài danh sách. Vì vậy trả cổng "không hỗ trợ": camera dùng
 * đường chính (track torch) và app nói SETTING_ACK TORCH_UNSUPPORTED nếu đèn không bật được. Không bịa tên plugin.
 *
 * Cách bổ sung sau này: chỉ sửa file này (cổng đã được camera và app dùng sẵn):
 * 1. plugin cộng đồng đã kiểm chứng trên máy thật, bản khớp Capacitor 7: import nằm trong file này, bọc try/catch,
 *    isSupported() hỏi plugin, set(on) trả true khi bật/tắt được và false (không ném) khi lỗi; hoặc
 * 2. viết plugin Capacitor nhỏ (Android: CameraManager.setTorchMode, cần quyền CAMERA đã cấp), cùng chữ ký trên.
 * Cần thử trên máy thật: nhiều máy không cho bật đèn bằng CameraManager khi WebView đang giữ camera.
 */
import type { ITorchPort } from '../contracts';

export function createNativeTorchPort(): ITorchPort {
  return {
    isSupported: async () => false,
    set: async () => false,
  };
}