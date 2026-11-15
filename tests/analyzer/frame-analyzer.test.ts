import { describe, expect, it } from 'vitest';
import { createFrameAnalyzer } from '../../src/analyzer/frame-analyzer';
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import type { AppConfig, BBox, Denomination, Detection, FrameAnalysis, GrayImage, IFrameAnalyzer, InferenceResult } from '../../src/contracts';
import { makeDetection, makeFrameMeta, makeGray, makeInferenceResult } from '../fakes';

const FRAME_STEP_MS = 333;
const box = (x1: number, y1: number, x2: number, y2: number): BBox => ({ x1, y1, x2, y2 });
/** Hộp 300 × 200 giữa khung 640 × 480: đủ lớn, không chạm mép. */
const CENTER = box(100, 100, 400, 300);
const LEFT = box(20, 100, 180, 300);
const RIGHT = box(300, 100, 460, 300);

const det = (frameId: number, index: number, denomination: Denomination, confidence: number, bbox: BBox): Detection =>
  makeDetection({ id: `${frameId}-${index}`, frameId, denomination, confidence, bbox: { ...bbox } });

/** Kết quả suy luận của khung thứ `frameId` (1, 2, ...), mốc thời gian cách nhau FRAME_STEP_MS. */
const result = (frameId: number, detections: Detection[], gray: GrayImage = makeGray(), timestamp = (frameId - 1) * FRAME_STEP_MS): InferenceResult =>
  makeInferenceResult({ meta: makeFrameMeta({ frameId, timestamp }), detections, gray });

/** Khung có một tờ chắc ở giữa với độ tin cậy cho trước. */
const singleFrame = (frameId: number, confidence = 0.9, denomination: Denomination = 20000): InferenceResult =>
  result(frameId, [det(frameId, 0, denomination, confidence, CENTER)]);

/** Ảnh xám bàn cờ đen trắng: rất nét, độ sáng trung bình 127,5. */
function checkerGray(width: number, height: number, cell: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0 : 255;
  }
  return { data, width, height };
}

interface ConfigPatch { inference?: Partial<AppConfig['inference']>; analyzer?: Partial<AppConfig['analyzer']> }
const withConfig = (patch: ConfigPatch): AppConfig => ({
  ...DEFAULT_CONFIG,
  inference: { ...DEFAULT_CONFIG.inference, ...patch.inference },
  analyzer: { ...DEFAULT_CONFIG.analyzer, ...patch.analyzer },
});

const run = (analyzer: IFrameAnalyzer, inputs: InferenceResult[]): FrameAnalysis[] => inputs.map((i) => analyzer.analyze(i));
const lastOf = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('createFrameAnalyzer · lắp FrameAnalysis', () => {
  it('lắp đủ mọi trường cho một khung có một tờ chắc', () => {
    const d = det(1, 0, 20000, 0.95, CENTER);
    const input = result(1, [d]);
    expect(createFrameAnalyzer(DEFAULT_CONFIG).analyze(input)).toEqual<FrameAnalysis>({
      meta: input.meta,
      detections: [d],
      sure: [d],
      unsure: [],
      overlap: { detected: false, maxRatio: 0, pairs: [] },
      conflict: { detected: false, pairs: [] },
      position: { tooSmall: false, partial: false },
      quality: { blurScore: 0, blurry: true, brightness: 128, lowLight: false },
      stability: { stable: false, agree: 1, window: 5, consensus: null },
      emptyStreak: 0,
    });
  });

  it('khung không có tiền: các danh sách rỗng, vẫn đo chất lượng ảnh', () => {
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(result(1, []));
    expect(analysis).toMatchObject({
      detections: [],
      sure: [],
      unsure: [],
      overlap: { detected: false },
      conflict: { detected: false },
      position: { tooSmall: false, partial: false },
      quality: { brightness: 128, lowLight: false },
      stability: { stable: false, agree: 0, window: 5, consensus: null },
      emptyStreak: 1,
    });
  });

  it('tách sure, unsure và loại detection dưới confLow', () => {
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(
      result(1, [det(1, 0, 20000, 0.9, LEFT), det(1, 1, 50000, 0.5, RIGHT), det(1, 2, 10000, 0.1, box(500, 100, 620, 300))]),
    );
    expect(analysis.sure.map((d) => d.id)).toEqual(['1-0']);
    expect(analysis.unsure.map((d) => d.id)).toEqual(['1-1']);
    expect(analysis.detections.map((d) => d.id)).toEqual(['1-0', '1-1']);
  });

  it('sắp detection từ trái sang phải dù đầu vào lộn xộn', () => {
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(
      result(1, [det(1, 0, 50000, 0.9, box(400, 100, 560, 300)), det(1, 1, 20000, 0.9, box(20, 100, 180, 300)), det(1, 2, 10000, 0.9, box(210, 100, 370, 300))]),
    );
    const expected = ['1-1', '1-2', '1-0'];
    expect(analysis.detections.map((d) => d.id)).toEqual(expected);
    expect(analysis.sure.map((d) => d.id)).toEqual(expected);
  });

  it('hòa tâm x thì xếp theo tâm y', () => {
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(
      result(1, [det(1, 0, 20000, 0.9, box(100, 250, 200, 350)), det(1, 1, 50000, 0.9, box(100, 50, 200, 150))]),
    );
    expect(analysis.detections.map((d) => d.id)).toEqual(['1-1', '1-0']);
  });

  it('meta được sao chép và các mảng kết quả là mảng mới', () => {
    const input = result(1, [det(1, 0, 20000, 0.9, CENTER)]);
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(input);
    expect(analysis.meta).toEqual(input.meta);
    expect(analysis.meta).not.toBe(input.meta);
    expect(analysis.detections).not.toBe(input.detections);
  });
});

describe('createFrameAnalyzer · chất lượng và vị trí', () => {
  it('ảnh xám nét thì không mờ, điểm vượt ngưỡng', () => {
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(result(1, [det(1, 0, 20000, 0.9, CENTER)], checkerGray(64, 48, 4)));
    expect(analysis.quality.blurry).toBe(false);
    expect(analysis.quality.blurScore).toBeGreaterThan(DEFAULT_CONFIG.analyzer.blurThreshold);
    expect(analysis.quality.brightness).toBeCloseTo(127.5, 9);
  });

  it('ảnh xám tối thì lowLight', () => {
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(result(1, [det(1, 0, 20000, 0.9, CENTER)], makeGray(64, 48, 20)));
    expect(analysis.quality).toMatchObject({ brightness: 20, lowLight: true });
  });

  it.each([
    { name: 'tờ sát mép trái là partial', bbox: box(0, 100, 300, 300), position: { tooSmall: false, partial: true } },
    { name: 'tờ quá nhỏ là tooSmall', bbox: box(300, 200, 340, 230), position: { tooSmall: true, partial: false } },
    { name: 'tờ vừa và ở giữa thì ổn', bbox: CENTER, position: { tooSmall: false, partial: false } },
  ])('$name', ({ bbox, position }) => {
    expect(createFrameAnalyzer(DEFAULT_CONFIG).analyze(result(1, [det(1, 0, 20000, 0.9, bbox)])).position).toEqual(position);
  });

  it('tờ chưa chắc cũng tham gia phát hiện chồng lấn với tờ chắc', () => {
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(
      result(1, [det(1, 0, 20000, 0.9, box(20, 100, 180, 300)), det(1, 1, 50000, 0.5, box(132, 100, 292, 300))]),
    );
    expect(analysis.overlap.pairs).toEqual([['1-0', '1-1']]);
  });

  it('tờ chưa chắc cùng chỗ nhưng khác mệnh giá với tờ chắc cũng báo conflict', () => {
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(result(1, [det(1, 0, 20000, 0.9, CENTER), det(1, 1, 50000, 0.5, CENTER)]));
    expect(analysis.conflict).toEqual({ detected: true, pairs: [['1-0', '1-1']] });
  });

  it('độ mờ đo trong vùng hộp tờ tiền chứ không phải toàn ảnh', () => {
    // Hộp CENTER quy về ảnh xám 64 × 48 là [10, 40) × [10, 30); mảnh phẳng rộng hơn một chút, quanh nó ảnh rất nét.
    const data = checkerGray(64, 48, 4).data.slice();
    for (let y = 8; y < 32; y++) for (let x = 8; x < 42; x++) data[y * 64 + x] = 128;
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(result(1, [det(1, 0, 20000, 0.9, CENTER)], { data, width: 64, height: 48 }));
    expect(analysis.quality).toMatchObject({ blurScore: 0, blurry: true });
  });

  it('kích thước khung lấy từ meta khi xét tờ quá nhỏ', () => {
    const d = det(1, 0, 20000, 0.9, CENTER);
    const small = makeInferenceResult({ meta: makeFrameMeta({ width: 1600, height: 1200 }), detections: [d] });
    expect(createFrameAnalyzer(DEFAULT_CONFIG).analyze(small).position.tooSmall).toBe(true);
    expect(createFrameAnalyzer(DEFAULT_CONFIG).analyze(result(1, [d])).position.tooSmall).toBe(false);
  });

  it('hai tờ chồng nhau thì báo overlap, hai tờ cùng chỗ khác mệnh giá thì báo conflict', () => {
    const analyzer = createFrameAnalyzer(DEFAULT_CONFIG);
    const overlapping = analyzer.analyze(result(1, [det(1, 0, 20000, 0.9, box(20, 100, 180, 300)), det(1, 1, 50000, 0.9, box(132, 100, 292, 300))]));
    expect(overlapping.overlap).toEqual({ detected: true, maxRatio: expect.closeTo(0.3, 9), pairs: [['1-0', '1-1']] });
    const conflicting = createFrameAnalyzer(DEFAULT_CONFIG).analyze(result(1, [det(1, 0, 20000, 0.9, CENTER), det(1, 1, 50000, 0.8, CENTER)]));
    expect(conflicting.conflict).toEqual({ detected: true, pairs: [['1-0', '1-1']] });
  });
});

describe('createFrameAnalyzer · ngưỡng đọc từ config (cùng đầu vào, đổi config thì kết quả đổi)', () => {
  const overlapInput = () => result(1, [det(1, 0, 20000, 0.9, box(20, 100, 180, 300)), det(1, 1, 50000, 0.9, box(132, 100, 292, 300))]);
  const conflictInput = () => result(1, [det(1, 0, 20000, 0.9, box(100, 100, 400, 300)), det(1, 1, 50000, 0.9, box(100, 100, 400, 220))]);

  it.each([
    { name: 'inference.confSure', patch: { inference: { confSure: 0.95 } }, input: () => singleFrame(1, 0.9), pick: (a: FrameAnalysis) => a.sure.length, byDefault: 1, patched: 0 },
    { name: 'inference.confLow', patch: { inference: { confLow: 0.6 } }, input: () => singleFrame(1, 0.5), pick: (a: FrameAnalysis) => a.detections.length, byDefault: 1, patched: 0 },
    { name: 'analyzer.overlapRatio', patch: { analyzer: { overlapRatio: 0.5 } }, input: overlapInput, pick: (a: FrameAnalysis) => a.overlap.detected, byDefault: true, patched: false },
    { name: 'analyzer.conflictIou', patch: { analyzer: { conflictIou: 0.8 } }, input: conflictInput, pick: (a: FrameAnalysis) => a.conflict.detected, byDefault: true, patched: false },
    { name: 'analyzer.minAreaRatio', patch: { analyzer: { minAreaRatio: 0.5 } }, input: () => singleFrame(1), pick: (a: FrameAnalysis) => a.position.tooSmall, byDefault: false, patched: true },
    { name: 'analyzer.edgeMarginRatio', patch: { analyzer: { edgeMarginRatio: 0.3 } }, input: () => singleFrame(1), pick: (a: FrameAnalysis) => a.position.partial, byDefault: false, patched: true },
    { name: 'analyzer.blurThreshold', patch: { analyzer: { blurThreshold: 1e9 } }, input: () => result(1, [det(1, 0, 20000, 0.9, CENTER)], checkerGray(64, 48, 4)), pick: (a: FrameAnalysis) => a.quality.blurry, byDefault: false, patched: true },
    { name: 'analyzer.lowLightMean', patch: { analyzer: { lowLightMean: 200 } }, input: () => singleFrame(1), pick: (a: FrameAnalysis) => a.quality.lowLight, byDefault: false, patched: true },
    {
      name: 'analyzer.stabilizer.minAgree',
      patch: { analyzer: { stabilizer: { ...DEFAULT_CONFIG.analyzer.stabilizer, minAgree: 1 } } },
      input: () => singleFrame(1),
      pick: (a: FrameAnalysis) => a.stability.stable,
      byDefault: false,
      patched: true,
    },
  ])('$name', ({ patch, input, pick, byDefault, patched }) => {
    expect(pick(createFrameAnalyzer(DEFAULT_CONFIG).analyze(input()))).toBe(byDefault);
    expect(pick(createFrameAnalyzer(withConfig(patch)).analyze(input()))).toBe(patched);
  });

  it('cấu hình stabilizer không hợp lệ thì ném RangeError ngay khi tạo', () => {
    const bad = withConfig({ analyzer: { stabilizer: { windowSize: 0, minAgree: 1, matchIou: 0.5, maxAgeMs: 2500 } } });
    expect(() => createFrameAnalyzer(bad)).toThrow(RangeError);
  });
});

describe('createFrameAnalyzer · ổn định theo thời gian (kịch bản nhiều khung)', () => {
  it('bốn khung giống nhau thì ổn định ở khung thứ tư, consensus là trung bình độ tin cậy', () => {
    const analyses = run(createFrameAnalyzer(DEFAULT_CONFIG), [0.8, 0.9, 0.85, 0.95].map((c, i) => singleFrame(i + 1, c)));
    expect(analyses.map((a) => a.stability.stable)).toEqual([false, false, false, true]);
    expect(analyses.map((a) => a.stability.agree)).toEqual([1, 2, 3, 4]);
    const consensus = lastOf(analyses)?.stability.consensus;
    expect(consensus?.[0]?.confidence).toBeCloseTo(0.875, 9);
    expect(consensus?.[0]).toMatchObject({ id: '4-0', denomination: 20000 });
  });

  it('hai tờ ổn định thì consensus giữ thứ tự trái → phải', () => {
    const frames = [1, 2, 3, 4].map((f) => result(f, [det(f, 0, 50000, 0.9, RIGHT), det(f, 1, 20000, 0.9, LEFT)]));
    const consensus = lastOf(run(createFrameAnalyzer(DEFAULT_CONFIG), frames))?.stability.consensus;
    expect(consensus?.map((d) => d.denomination)).toEqual([20000, 50000]);
  });

  it('khung hiện tại có thêm tờ chưa chắc thì không ổn định dù bốn khung trước đồng thuận', () => {
    const analyzer = createFrameAnalyzer(DEFAULT_CONFIG);
    run(analyzer, [1, 2, 3, 4].map((f) => singleFrame(f)));
    const withExtra = analyzer.analyze(result(5, [det(5, 0, 20000, 0.9, LEFT), det(5, 1, 50000, 0.5, RIGHT)]));
    expect(withExtra.stability).toEqual({ stable: false, agree: 0, window: 5, consensus: null });
  });

  it.each([
    {
      name: 'chồng lấn',
      detections: (f: number) => [det(f, 0, 20000, 0.9, box(20, 100, 180, 300)), det(f, 1, 50000, 0.9, box(132, 100, 292, 300))],
      flag: (a: FrameAnalysis) => a.overlap.detected,
    },
    {
      name: 'xung đột lớp',
      detections: (f: number) => [det(f, 0, 20000, 0.9, CENTER), det(f, 1, 50000, 0.8, CENTER)],
      flag: (a: FrameAnalysis) => a.conflict.detected,
    },
  ])('khung $name không bao giờ ổn định', ({ detections, flag }) => {
    const analyses = run(createFrameAnalyzer(DEFAULT_CONFIG), [1, 2, 3, 4, 5, 6].map((f) => result(f, detections(f))));
    expect(analyses.every(flag)).toBe(true);
    expect(analyses.some((a) => a.stability.stable)).toBe(false);
    expect(analyses.every((a) => a.stability.consensus === null)).toBe(true);
  });

  it('khung cách nhau 1000 ms bị loại theo maxAgeMs; nới maxAgeMs trong config thì ổn định', () => {
    const slow = () => [0, 1000, 2000, 3000].map((t, i) => result(i + 1, [det(i + 1, 0, 20000, 0.9, CENTER)], makeGray(), t));
    const byDefault = lastOf(run(createFrameAnalyzer(DEFAULT_CONFIG), slow()));
    expect(byDefault?.stability).toMatchObject({ stable: false, agree: 3 });
    const relaxed = withConfig({ analyzer: { stabilizer: { ...DEFAULT_CONFIG.analyzer.stabilizer, maxAgeMs: 5000 } } });
    expect(lastOf(run(createFrameAnalyzer(relaxed), slow()))?.stability).toMatchObject({ stable: true, agree: 4 });
  });

  it('đổi sang tờ khác: ổn định lại chỉ sau đủ bốn khung của tờ mới', () => {
    const frames = [20000, 20000, 20000, 20000, 50000, 50000, 50000, 50000].map((d, i) => singleFrame(i + 1, 0.9, d as Denomination));
    const analyses = run(createFrameAnalyzer(DEFAULT_CONFIG), frames);
    expect(analyses.map((a) => a.stability.stable)).toEqual([false, false, false, true, false, false, false, true]);
    expect(lastOf(analyses)?.stability.consensus?.map((d) => d.denomination)).toEqual([50000]);
  });

  it('rút tiền ra đủ cả cửa sổ khung trống rồi đưa lại thì phải đếm lại từ đầu', () => {
    const analyzer = createFrameAnalyzer(DEFAULT_CONFIG);
    run(analyzer, [1, 2, 3, 4].map((f) => singleFrame(f)));
    run(analyzer, [5, 6, 7, 8, 9].map((f) => result(f, [])));
    expect(analyzer.analyze(singleFrame(10)).stability).toMatchObject({ stable: false, agree: 1 });
  });

  it('reset xóa cửa sổ ổn định', () => {
    const analyzer = createFrameAnalyzer(DEFAULT_CONFIG);
    expect(lastOf(run(analyzer, [1, 2, 3, 4].map((f) => singleFrame(f))))?.stability.stable).toBe(true);
    analyzer.reset();
    expect(analyzer.analyze(singleFrame(5)).stability).toMatchObject({ stable: false, agree: 1 });
  });

  it('hai bộ phân tích tạo riêng không dùng chung trạng thái', () => {
    const first = createFrameAnalyzer(DEFAULT_CONFIG);
    const second = createFrameAnalyzer(DEFAULT_CONFIG);
    run(first, [1, 2, 3, 4].map((f) => singleFrame(f)));
    expect(second.analyze(singleFrame(5)).stability).toMatchObject({ stable: false, agree: 1 });
  });
});

describe('createFrameAnalyzer · emptyStreak', () => {
  it('tăng theo từng khung trống và về 0 khi có detection', () => {
    const inputs = [[], [], [det(3, 0, 20000, 0.9, CENTER)], [], [det(5, 0, 20000, 0.9, CENTER)]].map((d, i) => result(i + 1, d));
    expect(run(createFrameAnalyzer(DEFAULT_CONFIG), inputs).map((a) => a.emptyStreak)).toEqual([1, 2, 0, 1, 0]);
  });

  it('khung chỉ có tờ chưa chắc không phải khung trống', () => {
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(singleFrame(1, 0.5));
    expect(analysis).toMatchObject({ sure: [], emptyStreak: 0 });
    expect(analysis.unsure).toHaveLength(1);
  });

  it('chỉ có detection dưới confLow vẫn tính là khung trống', () => {
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(singleFrame(1, 0.1));
    expect(analysis.detections).toEqual([]);
    expect(analysis.emptyStreak).toBe(1);
  });

  it('reset đưa emptyStreak về 0', () => {
    const analyzer = createFrameAnalyzer(DEFAULT_CONFIG);
    run(analyzer, [1, 2, 3].map((f) => result(f, [])));
    analyzer.reset();
    expect(analyzer.analyze(result(4, [])).emptyStreak).toBe(1);
  });
});

describe('createFrameAnalyzer · không đột biến đầu vào', () => {
  it('đầu vào đóng băng sâu vẫn chạy được và không đổi', () => {
    const detections = [det(1, 0, 20000, 0.9, LEFT), det(1, 1, 50000, 0.5, RIGHT), det(1, 2, 10000, 0.1, box(500, 100, 620, 300))].reverse();
    const input = result(1, detections, checkerGray(64, 48, 4));
    const before = structuredClone(input);
    deepFreeze(input);
    const analyzer = createFrameAnalyzer(DEFAULT_CONFIG);
    expect(() => run(analyzer, [input, input, input, input])).not.toThrow();
    expect(input).toEqual(before);
  });

  it('sửa các mảng kết quả không ảnh hưởng đầu vào', () => {
    const input = result(1, [det(1, 0, 20000, 0.9, CENTER)]);
    const analysis = createFrameAnalyzer(DEFAULT_CONFIG).analyze(input);
    analysis.detections.length = 0;
    analysis.sure.length = 0;
    analysis.meta.frameId = 999;
    expect(input.detections).toHaveLength(1);
    expect(input.meta.frameId).toBe(1);
  });
});