// Kiểu Scenario và bộ sinh khung hình giả có hạt giống (seed) cho công cụ phát lại kịch bản.
// Mọi nhiễu lấy từ một bộ sinh mulberry32 duy nhất: cùng seed cho cùng dãy khung, từng bit.
import { DENOMINATIONS } from '../../src/contracts';
import type { AppConfig, BBox, Denomination, Detection, GrayImage, InferenceResult } from '../../src/contracts';
import { center } from '../../src/utils/geometry';
import { clamp, mulberry32 } from '../../src/utils/math';

/** Kích thước khung camera giả, pixel (cùng cỡ mặc định của tests/fakes: 640×480). */
export const FRAME_WIDTH = 640;
export const FRAME_HEIGHT = 480;
/** Số mili-giây trong một giây, để đổi targetFps thành chu kỳ khung. */
const MS_PER_SECOND = 1000;
/** Giá trị nhỏ nhất và lớn nhất của một điểm ảnh xám 8 bit. */
const GRAY_MIN = 0;
const GRAY_MAX = 255;

/*
 * Nội dung ảnh xám giả. Chọn đủ xa các ngưỡng mặc định (blurThreshold 60, lowLightMean 60);
 * test của công cụ kiểm tra bằng bộ đo thật của analyzer, nên đổi ngưỡng mà quên sửa ở đây sẽ bị test bắt.
 */
/** Ảnh nét: bàn cờ độ sáng 128 ± 40 (phương sai Laplacian = 64 × 40², rất lớn so với ngưỡng mờ). */
const SHARP_BASE = 128;
const SHARP_AMPLITUDE = 40;
/** Ảnh tối nhưng vẫn nét: bàn cờ độ sáng 20 ± 15 (trung bình 20 < ngưỡng thiếu sáng). */
const DARK_BASE = 20;
const DARK_AMPLITUDE = 15;
/** Ảnh mờ: dải chuyển sắc trơn từ 100 lên 156 theo chiều ngang (Laplacian gần như 0, trung bình 128). */
const BLURRY_BASE = 100;
const BLURRY_RANGE = 56;

export type FrameQuality = 'SHARP' | 'BLURRY' | 'DARK';
/** PUBLISH: hệ thống nên đọc tổng tiền; REJECT: Fail Safe, hệ thống KHÔNG được đọc. */
export type Expectation = 'PUBLISH' | 'REJECT';

/** Một vật trong cảnh: tờ tiền thật hoặc vật giống tiền mà mô hình "thấy" là một mệnh giá. */
export interface SceneObject {
  denomination: Denomination;
  /** Hộp chuẩn trong khung 640×480, pixel. */
  box: BBox;
  /** Độ tin cậy chuẩn của mô hình; là mảng thì xoay vòng theo chỉ số khung trong pha. */
  confidence: number | readonly number[];
}

/** Một đoạn liên tiếp của kịch bản có cảnh không đổi. */
export interface Phase {
  /** Số khe thời gian (khung) của pha, nguyên ≥ 0. */
  frames: number;
  /** Những gì MÔ HÌNH nhìn thấy (có thể ít hơn sự thật, ví dụ ca bỏ sót tờ). */
  objects: readonly SceneObject[];
  /** Sự thật của pha. Bỏ trống: pha không có vật là null, ngược lại dùng groundTruth của kịch bản. null: không có tiền. */
  truth?: readonly Denomination[] | null;
}

/** Nhiễu thêm vào khung; mọi trường mặc định 0 (không nhiễu). */
export interface NoiseSpec {
  /** Độ lệch chuẩn của nhiễu độ tin cậy (thang 0..1). */
  confidenceSigma: number;
  /** Độ lệch chuẩn của nhiễu vị trí, pixel (dịch cả hộp). */
  positionSigmaPx: number;
  /** Xác suất khung bị rơi: khe thời gian vẫn trôi nhưng khung không tới analyzer. */
  dropRate: number;
  /** Xác suất khung mờ. */
  blurRate: number;
  /** Xác suất khung tối. */
  darkRate: number;
}

export const NO_NOISE: NoiseSpec = { confidenceSigma: 0, positionSigmaPx: 0, dropRate: 0, blurRate: 0, darkRate: 0 };

/** Mô tả cách sinh khung: các pha nối tiếp theo thời gian cộng nhiễu. */
export interface GenerationSpec {
  phases: readonly Phase[];
  noise?: Partial<NoiseSpec>;
}

export interface Scenario {
  /** Mã ngắn ổn định, dùng làm khoá trong báo cáo (ví dụ "single-20000"). */
  id: string;
  /** Tên tiếng Việt cho người đọc báo cáo. */
  name: string;
  /** Mệnh giá thật từ trái sang phải; null khi không có tiền trong cảnh. */
  groundTruth: readonly Denomination[] | null;
  expectation: Expectation;
  generation: GenerationSpec;
  /** true: hạn chế đã biết của hệ thống, được báo cáo RIÊNG, không tính vào Unsafe Read Rate chính. */
  knownLimitation: boolean;
  notes: string;
}

/** Một khe thời gian của kịch bản sau khi sinh. */
export interface SyntheticFrame {
  /** Chỉ số khe, từ 0 (tính cả khung rơi). */
  slot: number;
  frameId: number;
  /** Thời điểm giả, mili-giây kể từ đầu kịch bản. */
  atMs: number;
  dropped: boolean;
  quality: FrameQuality;
  /** Sự thật tại khung này: mệnh giá thật trái → phải, hoặc null khi không có tiền. */
  truth: readonly Denomination[] | null;
  /** Kết quả suy luận giả; null khi khung rơi. */
  result: InferenceResult | null;
}

/** Tham số suy ra từ AppConfig để sinh khung. */
export interface GeneratorOptions {
  frameWidth: number;
  frameHeight: number;
  frameIntervalMs: number;
  grayWidth: number;
  grayHeight: number;
  /** Mô hình thật không xuất hộp dưới confLow, nên bộ sinh cũng bỏ chúng. */
  confLow: number;
}

export function deriveGeneratorOptions(config: AppConfig): GeneratorOptions {
  const grayWidth = config.analyzer.grayThumbWidth;
  return {
    frameWidth: FRAME_WIDTH,
    frameHeight: FRAME_HEIGHT,
    frameIntervalMs: Math.round(MS_PER_SECOND / config.inference.targetFps),
    grayWidth,
    grayHeight: Math.round((grayWidth * FRAME_HEIGHT) / FRAME_WIDTH),
    confLow: config.inference.confLow,
  };
}

/** Ảnh xám giả theo chất lượng; dữ liệu clamp vào 0..255. */
function buildGray(quality: FrameQuality, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const checker = (x + y) % 2 === 0 ? 1 : -1;
      let value: number;
      if (quality === 'SHARP') value = SHARP_BASE + checker * SHARP_AMPLITUDE;
      else if (quality === 'DARK') value = DARK_BASE + checker * DARK_AMPLITUDE;
      else value = Math.floor(BLURRY_BASE + (x * BLURRY_RANGE) / width);
      data[y * width + x] = clamp(value, GRAY_MIN, GRAY_MAX);
    }
  }
  return { data, width, height };
}

/** Bộ nhớ đệm ảnh xám theo (chất lượng, cỡ): dựng ảnh tốn kém mà không ai sửa nó (analyzer chỉ đọc), nên dùng chung giữa các lần sinh. */
const grayCache = new Map<string, GrayImage>();

function cachedGray(quality: FrameQuality, width: number, height: number): GrayImage {
  const key = `${quality}:${width}x${height}`;
  const hit = grayCache.get(key);
  if (hit !== undefined) return hit;
  const made = buildGray(quality, width, height);
  grayCache.set(key, made);
  return made;
}

/** Số ngẫu nhiên chuẩn N(0, 1) bằng Box–Muller. Luôn tiêu thụ đúng 2 số từ rng. */
function gaussian(rng: () => number): number {
  const u1 = 1 - rng(); // (0, 1] để log không ra -∞
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function confidenceAt(c: number | readonly number[], index: number): number {
  if (typeof c === 'number') return c;
  const value = c[index % c.length];
  if (value === undefined) throw new RangeError('SceneObject.confidence là mảng rỗng');
  return value;
}

function resolveTruth(scenario: Scenario, phase: Phase): readonly Denomination[] | null {
  if (phase.truth !== undefined) return phase.truth;
  return phase.objects.length === 0 ? null : scenario.groundTruth;
}

/** Detection của một khung: thêm nhiễu, bỏ hộp dưới confLow, sắp trái → phải, đánh id `${frameId}-${index}`. */
function buildDetections(
  objects: readonly SceneObject[], indexInPhase: number, frameId: number, atMs: number,
  noise: NoiseSpec, options: GeneratorOptions, rng: () => number,
): Detection[] {
  const noisy = objects.map((o) => {
    // Luôn rút đủ 3 số chuẩn cho mỗi vật để dãy ngẫu nhiên không lệch khi một vật bị bỏ.
    const confidence = clamp(confidenceAt(o.confidence, indexInPhase) + noise.confidenceSigma * gaussian(rng), 0, 1);
    const dx = noise.positionSigmaPx * gaussian(rng);
    const dy = noise.positionSigmaPx * gaussian(rng);
    const bbox: BBox = { x1: o.box.x1 + dx, y1: o.box.y1 + dy, x2: o.box.x2 + dx, y2: o.box.y2 + dy };
    return { denomination: o.denomination, confidence, bbox };
  });
  return noisy
    .filter((d) => d.confidence >= options.confLow)
    .sort((a, b) => center(a.bbox).x - center(b.bbox).x || center(a.bbox).y - center(b.bbox).y)
    .map((d, index) => ({
      id: `${frameId}-${index}`,
      // Quy ước của công cụ (giống tests/fakes): classId = vị trí mệnh giá trong DENOMINATIONS. Analyzer không dùng classId.
      classId: DENOMINATIONS.indexOf(d.denomination),
      denomination: d.denomination,
      confidence: d.confidence,
      bbox: d.bbox,
      frameId,
      timestamp: atMs,
    }));
}

function assertValidPhases(scenario: Scenario): void {
  for (const phase of scenario.generation.phases) {
    if (!Number.isInteger(phase.frames) || phase.frames < 0) {
      throw new RangeError(`Kịch bản ${scenario.id}: phase.frames phải là số nguyên ≥ 0, nhận ${String(phase.frames)}`);
    }
  }
}

/**
 * Sinh dãy khe thời gian của một kịch bản. Thuần: chỉ phụ thuộc (scenario, seed, options).
 * Mỗi khe rút ngẫu nhiên theo thứ tự cố định (rơi, chất lượng, rồi nhiễu từng vật), kể cả khi khung bị rơi,
 * nên đổi dropRate không làm lệch nhiễu của các khung còn lại.
 */
export function generateFrames(scenario: Scenario, seed: number, options: GeneratorOptions): SyntheticFrame[] {
  assertValidPhases(scenario);
  const rng = mulberry32(seed);
  const noise: NoiseSpec = { ...NO_NOISE, ...scenario.generation.noise };
  const grays: Record<FrameQuality, GrayImage> = {
    SHARP: cachedGray('SHARP', options.grayWidth, options.grayHeight),
    BLURRY: cachedGray('BLURRY', options.grayWidth, options.grayHeight),
    DARK: cachedGray('DARK', options.grayWidth, options.grayHeight),
  };
  const frames: SyntheticFrame[] = [];
  let slot = 0;
  for (const phase of scenario.generation.phases) {
    const truth = resolveTruth(scenario, phase);
    for (let k = 0; k < phase.frames; k++, slot++) {
      const dropped = rng() < noise.dropRate;
      const qualityDraw = rng();
      const quality: FrameQuality =
        qualityDraw < noise.blurRate ? 'BLURRY' : qualityDraw < noise.blurRate + noise.darkRate ? 'DARK' : 'SHARP';
      const frameId = slot + 1;
      const atMs = slot * options.frameIntervalMs;
      const detections = buildDetections(phase.objects, k, frameId, atMs, noise, options, rng);
      const result: InferenceResult | null = dropped
        ? null
        : {
            meta: { frameId, width: options.frameWidth, height: options.frameHeight, timestamp: atMs },
            detections,
            gray: grays[quality],
            timings: { preprocessMs: 0, inferMs: 0, postprocessMs: 0, totalMs: 0 },
          };
      frames.push({ slot, frameId, atMs, dropped, quality, truth, result });
    }
  }
  return frames;
}