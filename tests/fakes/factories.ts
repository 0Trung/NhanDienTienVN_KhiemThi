import { DENOMINATIONS } from '../../src/contracts';
import type { Denomination, Detection, FrameAnalysis, FrameMeta, GrayImage, InferenceResult } from '../../src/contracts';
import { overlapOverMin } from '../../src/utils/geometry';

/** Siêu dữ liệu khung hình giả: 640×480. */
export function makeFrameMeta(overrides: Partial<FrameMeta> = {}): FrameMeta {
  return { frameId: 1, width: 640, height: 480, timestamp: 0, ...overrides };
}

/** Ảnh xám đồng màu (mặc định 64×48, giá trị 128). */
export function makeGray(width = 64, height = 48, value = 128): GrayImage {
  return { data: new Uint8Array(width * height).fill(value), width, height };
}

/**
 * Detection giả. Mặc định: 20000đ, độ tin cậy 0,9, hộp 300×200 giữa khung 640×480.
 * classId mặc định = chỉ số của mệnh giá trong DENOMINATIONS (chỉ là quy ước của đồ giả,
 * code thật phải tra classId qua classes.json).
 */
export function makeDetection(overrides: Partial<Detection> = {}): Detection {
  const frameId = overrides.frameId ?? 1;
  const denomination: Denomination = overrides.denomination ?? 20000;
  return {
    id: `${frameId}-0`,
    classId: DENOMINATIONS.indexOf(denomination),
    confidence: 0.9,
    bbox: { x1: 100, y1: 100, x2: 400, y2: 300 },
    frameId,
    timestamp: 0,
    ...overrides,
    denomination,
  };
}

/** Kết quả suy luận giả; mặc định không có detection. */
export function makeInferenceResult(overrides: Partial<InferenceResult> = {}): InferenceResult {
  return {
    meta: makeFrameMeta(),
    detections: [],
    gray: makeGray(),
    timings: { preprocessMs: 1, inferMs: 1, postprocessMs: 1, totalMs: 3 },
    ...overrides,
  };
}

/**
 * Phân tích khung hình giả. Mặc định là KHUNG KHÔNG CÓ TIỀN (emptyStreak = 1).
 * `overrides` thay thế nguyên từng trường cấp một (không trộn sâu).
 */
export function makeAnalysis(overrides: Partial<FrameAnalysis> = {}): FrameAnalysis {
  return {
    meta: makeFrameMeta(),
    detections: [],
    sure: [],
    unsure: [],
    overlap: { detected: false, maxRatio: 0, pairs: [] },
    conflict: { detected: false, pairs: [] },
    position: { tooSmall: false, partial: false },
    quality: { blurScore: 200, blurry: false, brightness: 120, lowLight: false },
    stability: { stable: false, agree: 0, window: 5, consensus: null },
    emptyStreak: 1,
    ...overrides,
  };
}

/** Xếp các tờ tiền từ trái sang phải trong khung 640×480, không chồng nhau, không sát mép. */
function layoutRow(
  denominations: readonly Denomination[],
  confidence: number | readonly number[],
  frameId = 1,
): Detection[] {
  const slot = Math.min(180, 600 / Math.max(1, denominations.length));
  return denominations.map((denomination, index) => {
    const x1 = 20 + index * slot;
    return makeDetection({
      id: `${frameId}-${index}`,
      frameId,
      denomination,
      confidence: typeof confidence === 'number' ? confidence : (confidence[index] ?? 0.9),
      bbox: { x1, y1: 100, x2: x1 + slot - 20, y2: 300 },
    });
  });
}

/** Khung có MỘT tờ chắc chắn (độ tin cậy 0,95), chưa ổn định theo thời gian. */
export function makeSingleSureAnalysis(
  denomination: Denomination = 20000,
  overrides: Partial<FrameAnalysis> = {},
): FrameAnalysis {
  const detections = layoutRow([denomination], 0.95);
  return makeAnalysis({
    detections,
    sure: detections,
    emptyStreak: 0,
    stability: { stable: false, agree: 1, window: 5, consensus: null },
    ...overrides,
  });
}

/** Khung có MỘT tờ chưa chắc (mặc định 0,5: nằm giữa confLow và confSure). */
export function makeUnsureAnalysis(
  denomination: Denomination = 20000,
  confidence = 0.5,
  overrides: Partial<FrameAnalysis> = {},
): FrameAnalysis {
  const detections = layoutRow([denomination], confidence);
  return makeAnalysis({ detections, unsure: detections, emptyStreak: 0, ...overrides });
}

/** Khung có hai tờ chắc chắn chồng lên nhau (tờ thứ hai đè 40px lên tờ thứ nhất, tỷ lệ chồng 0,25). */
export function makeOverlapAnalysis(
  first: Denomination = 20000,
  second: Denomination = 50000,
  overrides: Partial<FrameAnalysis> = {},
): FrameAnalysis {
  const [a, b] = layoutRow([first, second], 0.9);
  if (a === undefined || b === undefined) throw new Error('layoutRow phải trả về hai phần tử');
  const width = b.bbox.x2 - b.bbox.x1;
  const x1 = a.bbox.x2 - 40;
  const moved = makeDetection({ ...b, bbox: { x1, y1: b.bbox.y1, x2: x1 + width, y2: b.bbox.y2 } });
  const detections = [a, moved];
  return makeAnalysis({
    detections,
    sure: detections,
    emptyStreak: 0,
    overlap: { detected: true, maxRatio: overlapOverMin(a.bbox, moved.bbox), pairs: [[a.id, moved.id]] },
    ...overrides,
  });
}

/**
 * Khung xung đột: hai detection CÙNG vị trí nhưng KHÁC mệnh giá (cả hai ≥ confSure).
 * Cờ overlap để không phát hiện: xung đột được ưu tiên hơn chồng lấn.
 */
export function makeConflictAnalysis(
  first: Denomination = 20000,
  second: Denomination = 50000,
  overrides: Partial<FrameAnalysis> = {},
): FrameAnalysis {
  const [a, b] = layoutRow([first, second], [0.85, 0.8]);
  if (a === undefined || b === undefined) throw new Error('layoutRow phải trả về hai phần tử');
  const sameSpot = makeDetection({ ...b, bbox: { ...a.bbox } });
  const detections = [a, sameSpot];
  return makeAnalysis({
    detections,
    sure: detections,
    emptyStreak: 0,
    conflict: { detected: true, pairs: [[a.id, sameSpot.id]] },
    ...overrides,
  });
}

/** Khung ổn định: các tờ chắc chắn (0,95), 5/5 khung đồng thuận, consensus = chính các detection. */
export function makeStableAnalysis(
  denominations: readonly Denomination[] = [20000],
  overrides: Partial<FrameAnalysis> = {},
): FrameAnalysis {
  const detections = layoutRow(denominations, 0.95);
  return makeAnalysis({
    detections,
    sure: detections,
    emptyStreak: 0,
    stability: { stable: true, agree: 5, window: 5, consensus: detections },
    ...overrides,
  });
}