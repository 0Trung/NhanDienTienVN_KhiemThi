import type { BBox, FrameAnalysis, FrameMeta, GrayImage } from '../contracts';
import { isValidBox } from '../utils/geometry';
import { clamp } from '../utils/math';

/** Tỷ lệ cạnh của vùng giữa ảnh được dùng khi không có hộp nào (60%), không đơn vị. */
export const BLUR_CENTER_REGION_RATIO = 0.6;

/** Cạnh tối thiểu của vùng đo, điểm ảnh: vùng có ít hơn 16 × 16 điểm là không đủ dữ liệu. */
export const BLUR_MIN_REGION_SIDE = 16;

/** Giá trị blurScore báo "không đủ dữ liệu để đo" (một điểm số thật luôn ≥ 0). */
export const BLUR_NOT_ENOUGH_DATA = -1;

/** Kết quả đo độ mờ, đúng phần tương ứng của FrameAnalysis['quality']. */
export type BlurInfo = Pick<FrameAnalysis['quality'], 'blurScore' | 'blurry'>;

/** Hình chữ nhật nửa mở trong tọa độ ảnh xám, điểm ảnh: x ∈ [x0, x1), y ∈ [y0, y1). */
interface Rect { x0: number; y0: number; x1: number; y1: number }

function notEnoughData(): BlurInfo {
  return { blurScore: BLUR_NOT_ENOUGH_DATA, blurry: false };
}

/** Quy hộp (pixel khung gốc) về hình chữ nhật trong ảnh xám, làm tròn ra ngoài và cắt vào ảnh. Nhân trước, chia sau để số nguyên không bị lệch. */
function boxToRect(b: BBox, frame: Pick<FrameMeta, 'width' | 'height'>, gw: number, gh: number): Rect {
  return {
    x0: clamp(Math.floor((b.x1 * gw) / frame.width), 0, gw),
    y0: clamp(Math.floor((b.y1 * gh) / frame.height), 0, gh),
    x1: clamp(Math.ceil((b.x2 * gw) / frame.width), 0, gw),
    y1: clamp(Math.ceil((b.y2 * gh) / frame.height), 0, gh),
  };
}

/** Vùng giữa ảnh xám chiếm BLUR_CENTER_REGION_RATIO mỗi chiều. */
function centerRect(gw: number, gh: number): Rect {
  const cw = Math.round(gw * BLUR_CENTER_REGION_RATIO);
  const ch = Math.round(gh * BLUR_CENTER_REGION_RATIO);
  const x0 = Math.floor((gw - cw) / 2);
  const y0 = Math.floor((gh - ch) / 2);
  return { x0, y0, x1: x0 + cw, y1: y0 + ch };
}

/**
 * Đo độ mờ bằng phương sai của bộ lọc Laplacian 3×3 (0,1,0 / 1,-4,1 / 0,1,0) trên ảnh xám.
 * Ảnh càng nét thì cạnh càng gắt, phương sai càng lớn; ảnh mờ hoặc phẳng cho phương sai nhỏ.
 *
 * Vùng đo:
 * - Có ít nhất một hộp hợp lệ: chỉ tính trong VÙNG HỢP của các hộp, sau khi quy từ pixel khung gốc
 *   (frame.width × frame.height) về tọa độ ảnh xám (làm tròn ra ngoài, cắt vào ảnh). Hộp suy biến bị bỏ qua.
 * - Không có hộp hợp lệ nào: tính trên 60% vùng giữa ảnh (BLUR_CENTER_REGION_RATIO mỗi chiều).
 *
 * Chỉ các điểm nằm trong vùng đo VÀ không thuộc hàng/cột ngoài cùng của ảnh (để đủ 4 điểm lân cận) được lấy mẫu.
 * KHÔNG ĐỦ DỮ LIỆU: nếu số điểm lấy mẫu < 16 × 16 = 256 (vùng quá nhỏ, hộp nằm ngoài khung, ảnh xám nhỏ hơn 3 × 3,
 * dữ liệu ảnh ngắn hơn width × height, hoặc kích thước khung không hợp lệ khi có hộp) thì trả
 * blurScore = -1 và blurry = false: thiếu dữ liệu thì không kết luận là mờ.
 *
 * @param gray Ảnh xám 1 kênh theo hàng, mỗi điểm 0..255, giữ tỷ lệ khung gốc, không có lề.
 * @param frame Kích thước khung gốc, pixel; dùng để quy hộp về tọa độ ảnh xám.
 * @param boxes Các hộp (pixel khung gốc); không sửa mảng này.
 * @param blurThreshold Ngưỡng mờ, đơn vị là phương sai Laplacian trên thang xám 0..255 (config.analyzer.blurThreshold).
 * @returns blurScore: phương sai Laplacian (≥ 0) hoặc -1 nếu không đủ dữ liệu; blurry: blurScore < blurThreshold (nghiêm ngặt).
 */
export function measureBlur(
  gray: GrayImage,
  frame: Pick<FrameMeta, 'width' | 'height'>,
  boxes: readonly BBox[],
  blurThreshold: number,
): BlurInfo {
  const { width: gw, height: gh, data } = gray;
  if (!Number.isInteger(gw) || !Number.isInteger(gh) || gw < 3 || gh < 3 || data.length < gw * gh) {
    return notEnoughData();
  }

  const validBoxes = boxes.filter(isValidBox);
  const rects: Rect[] = [];
  if (validBoxes.length === 0) {
    rects.push(centerRect(gw, gh));
  } else {
    if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height) || !(frame.width > 0) || !(frame.height > 0)) {
      return notEnoughData();
    }
    for (const b of validBoxes) rects.push(boxToRect(b, frame, gw, gh));
  }

  const mask = new Uint8Array(gw * gh);
  for (const r of rects) {
    for (let y = r.y0; y < r.y1; y++) mask.fill(1, y * gw + r.x0, y * gw + r.x1);
  }

  let count = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      if (mask[i] === 0) continue;
      const lap = (data[i - gw] ?? 0) + (data[i + gw] ?? 0) + (data[i - 1] ?? 0) + (data[i + 1] ?? 0) - 4 * (data[i] ?? 0);
      count++;
      sum += lap;
      sumSq += lap * lap;
    }
  }
  if (count < BLUR_MIN_REGION_SIDE * BLUR_MIN_REGION_SIDE) return notEnoughData();

  const mu = sum / count;
  const variance = Math.max(0, sumSq / count - mu * mu);
  return { blurScore: variance, blurry: variance < blurThreshold };
}