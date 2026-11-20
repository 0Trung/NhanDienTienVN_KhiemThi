// Hằng số bố cục dùng chung cho các kịch bản. Mọi hộp nằm trọn trong khung 640×480, cách mép ≥ 20 px
// (xa hơn nhiều so với edgeMarginRatio × 480 ≈ 5 px) và rộng hơn minAreaRatio (4% khung), để chỉ các ca CỐ Ý khó mới gây từ chối.
import type { BBox, Denomination } from '../../../src/contracts';
import type { Phase, SceneObject } from '../scenario';

/** Độ dài pha ổn định: 30 khung ≈ 10 giây ở 3 fps, đủ để thấy cả hành vi sau khi đã đọc (anti-repeat). */
export const STABLE_FRAMES = 30;
/** Độ tin cậy của một tờ "chắc chắn" (≥ confSure mặc định 0,7). */
export const CONF_STABLE = 0.9;
/** Độ tin cậy của mô hình rất chắc, dùng ở ca bỏ sót tờ để chứng minh độ tin cậy cao vẫn không cứu được. */
export const CONF_VERY_SURE = 0.95;
/** Độ tin cậy "chưa chắc" (giữa confLow 0,25 và confSure 0,7). */
export const CONF_UNSURE = 0.55;

/** Một tờ đặt giữa khung. */
export const SINGLE_BOX: BBox = { x1: 170, y1: 140, x2: 470, y2: 340 };
/** Hai tờ đặt xa nhau (cách nhau 80 px). */
export const TWO_FAR_BOXES: readonly [BBox, BBox] = [
  { x1: 40, y1: 150, x2: 280, y2: 330 },
  { x1: 360, y1: 150, x2: 600, y2: 330 },
];
/** Ba tờ đặt xa nhau (cách nhau 45 px). */
export const THREE_FAR_BOXES: readonly [BBox, BBox, BBox] = [
  { x1: 20, y1: 180, x2: 190, y2: 300 },
  { x1: 235, y1: 180, x2: 405, y2: 300 },
  { x1: 450, y1: 180, x2: 620, y2: 300 },
];
/** Hai tờ chồng nhau: phần giao ≈ 30% hộp nhỏ hơn (ngưỡng overlapRatio mặc định 15%). */
export const OVERLAP_BOXES: readonly [BBox, BBox] = [
  { x1: 100, y1: 150, x2: 340, y2: 330 },
  { x1: 260, y1: 170, x2: 500, y2: 350 },
];

/** Pha có các vật cho trước, kéo dài `frames` khung. */
export const phaseOf = (frames: number, objects: readonly SceneObject[], truth?: readonly Denomination[] | null): Phase =>
  truth === undefined ? { frames, objects } : { frames, objects, truth };

/** Một tờ chắc chắn đặt giữa khung. */
export const singleNote = (denomination: Denomination, confidence: number | readonly number[] = CONF_STABLE): SceneObject => ({
  denomination,
  box: SINGLE_BOX,
  confidence,
});