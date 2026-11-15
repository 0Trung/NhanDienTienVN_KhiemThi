import type { FrameAnalysis, GrayImage } from '../contracts';
import { mean } from '../utils/math';

/** Kết quả đo độ sáng, đúng phần tương ứng của FrameAnalysis['quality']. */
export type BrightnessInfo = Pick<FrameAnalysis['quality'], 'brightness' | 'lowLight'>;

/**
 * Đo độ sáng trung bình của ảnh xám.
 * brightness là trung bình cộng mọi điểm ảnh, thang 0..255 (0 = đen, 255 = trắng);
 * lowLight = brightness < lowLightMean (nghiêm ngặt, đúng ranh thì chưa coi là thiếu sáng).
 * Ảnh rỗng (không có điểm ảnh) cho brightness = 0 và lowLight = true: không đo được thì coi là tối.
 *
 * @param gray Ảnh xám 1 kênh, mỗi điểm 0..255.
 * @param lowLightMean Ngưỡng thiếu sáng, thang 0..255 (config.analyzer.lowLightMean).
 */
export function measureBrightness(gray: GrayImage, lowLightMean: number): BrightnessInfo {
  const brightness = mean(gray.data);
  return { brightness, lowLight: brightness < lowLightMean };
}