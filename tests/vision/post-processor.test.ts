import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import { AppError } from '../../src/contracts';
import type { BBox, Denomination, Detection, FrameMeta, LetterboxMeta, RawModelOutput } from '../../src/contracts';
import { createPostProcessor } from '../../src/vision/post-processor';

/** Thứ tự lớp THẬT của public/models/classes.json (không theo mệnh giá): test không ngầm giả định classId = chỉ số mệnh giá. */
const CLASS_MAP: readonly Denomination[] = [1000, 10000, 100000, 2000, 20000, 200000, 5000, 50000, 500000];
const INFERENCE = DEFAULT_CONFIG.inference;
/** YOLO có 4 kênh toạ độ đứng đầu: ghi cứng ở đây để test không dựa vào hằng số của code thật. */
const CHANNELS = 4 + CLASS_MAP.length;

type Layout = 'channels_first' | 'channels_last';

/** Một anchor tổng hợp: hộp tâm-rộng-cao theo pixel ảnh vuông S×S, lớp `cls` có điểm `score`. */
interface Anchor {
  cx: number; cy: number; w: number; h: number; cls: number; score: number;
  /** Điểm của các lớp khác (classId → điểm). */
  also?: Readonly<Record<number, number>>;
  /** Chỉ số anchor trong tensor; mặc định là vị trí trong danh sách. */
  at?: number;
}

const anchor = (cx: number, cy: number, w: number, h: number, cls: number, score: number): Anchor => ({
  cx, cy, w, h, cls, score,
});

/** Tensor tổng hợp [1, 4+nc, N] hoặc [1, N, 4+nc]. Anchor không được liệt kê có mọi điểm bằng 0 nên bị confLow loại. */
function makeRaw(count: number, layout: Layout, anchors: readonly Anchor[]): RawModelOutput {
  const data = new Float32Array(count * CHANNELS);
  const put = (i: number, c: number, v: number): void => {
    data[layout === 'channels_first' ? c * count + i : i * CHANNELS + c] = v;
  };
  anchors.forEach((a, index) => {
    const i = a.at ?? index;
    [a.cx, a.cy, a.w, a.h].forEach((v, c) => put(i, c, v));
    for (const [cls, score] of Object.entries({ ...a.also, [a.cls]: a.score })) put(i, 4 + Number(cls), score);
  });
  return { data, dims: layout === 'channels_first' ? [1, CHANNELS, count] : [1, count, CHANNELS] };
}

/** Letterbox đúng công thức của bản mẫu P01 (CELL 5), viết riêng cho test, không import P03. */
function letterboxFor(srcWidth: number, srcHeight: number, inputSize: number): LetterboxMeta {
  const scale = Math.min(inputSize / srcWidth, inputSize / srcHeight);
  const newWidth = Math.max(Math.round(srcWidth * scale), 1);
  const newHeight = Math.max(Math.round(srcHeight * scale), 1);
  return {
    inputSize, srcWidth, srcHeight, scale, newWidth, newHeight,
    padX: Math.round((inputSize - newWidth) / 2 - 0.1),
    padY: Math.round((inputSize - newHeight) / 2 - 0.1),
  };
}

const frame = (frameId = 1): FrameMeta => ({ frameId, width: 640, height: 480, timestamp: frameId * 100 + 0.5 });

/** Chạy hàm và trả về AppError nó ném ra; thất bại nếu hàm không ném hoặc ném lỗi khác. */
function thrown(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Mong đợi hàm ném AppError nhưng nó không ném gì');
}

/** Ảnh gốc 640×640 vào S=640: scale 1, không lề, nên toạ độ trả về trùng toạ độ ảnh vuông. */
const IDENTITY = letterboxFor(640, 640, 640);

interface RunOptions {
  layout?: Layout;
  inference?: Partial<typeof INFERENCE>;
  letterbox?: LetterboxMeta;
  count?: number;
  classMap?: readonly Denomination[];
}

/** Chạy một khung: tensor tổng hợp (mặc định 64 anchor) qua một bộ xử lý mới. */
function run(anchors: readonly Anchor[], o: RunOptions = {}): Detection[] {
  const pp = createPostProcessor({ classMap: o.classMap ?? CLASS_MAP, inference: { ...INFERENCE, ...o.inference } });
  return pp.process(makeRaw(o.count ?? 64, o.layout ?? 'channels_first', anchors), o.letterbox ?? IDENTITY, frame());
}

const confidences = (ds: Detection[]): number[] => ds.map((d) => d.confidence);
const float32 = (xs: number[]): number[] => xs.map((x) => Math.fround(x));

/** Ô thứ i của lưới 20 cột, bước 30 px, hộp 10×10 (lệch dx px): các ô khác nhau không chạm nhau nên NMS không loại hộp nào. */
const cell = (i: number, score: number, dx = 0): Anchor =>
  anchor(10 + (i % 20) * 30 + dx, 10 + Math.floor(i / 20) * 30, 10, 10, i % CLASS_MAP.length, score);
const grid = (total: number, score: (i: number) => number): Anchor[] =>
  Array.from({ length: total }, (_, i) => cell(i, score(i)));

/** So từng cạnh của hộp với sai số tuyệt đối 10^-digits. */
function expectBox(actual: BBox | undefined, expected: BBox, digits: number): void {
  for (const key of ['x1', 'y1', 'x2', 'y2'] as const) expect(actual?.[key]).toBeCloseTo(expected[key], digits);
}

describe('một anchor điểm cao (F2, F5, F6)', () => {
  it.each([
    {
      name: 'ảnh ngang 1280×720, S=640 (lề trên/dưới)',
      lb: letterboxFor(1280, 720, 640),
      a: anchor(320, 320, 200, 100, 4, 0.9),
      denomination: 20000,
      bbox: { x1: 440, y1: 260, x2: 840, y2: 460 },
    },
    {
      name: 'ảnh dọc 480×640, S=640 (lề trái/phải)',
      lb: letterboxFor(480, 640, 640),
      a: anchor(320, 300, 100, 200, 7, 0.8),
      denomination: 50000,
      bbox: { x1: 190, y1: 200, x2: 290, y2: 400 },
    },
    {
      name: 'ảnh 640×480, S=416 (scale 0,65, lề trên/dưới)',
      lb: letterboxFor(640, 480, 416),
      a: anchor(208, 208, 130, 65, 0, 0.75),
      denomination: 1000,
      bbox: { x1: 220, y1: 190, x2: 420, y2: 290 },
    },
  ])('$name', ({ lb, a, denomination, bbox }) => {
    const result = run([{ ...a, at: 11 }], { letterbox: lb });
    expect(result).toHaveLength(1);
    expect(result[0]?.denomination).toBe(denomination);
    expect(result[0]?.classId).toBe(a.cls);
    expectBox(result[0]?.bbox, bbox, 3);
  });

  interface ArgmaxCase { name: string; main: number; also: Record<number, number>; winner: number }
  it.each<ArgmaxCase>([
    { name: 'điểm cao nhất thắng', main: 0.6, also: { 7: 0.9 }, winner: 7 },
    { name: 'hoà điểm thì lớp có chỉ số nhỏ hơn thắng', main: 0.6, also: { 2: 0.6 }, winner: 2 },
    { name: 'lớp thắng là lớp duy nhất vượt ngưỡng', main: 0.6, also: { 2: 0.1, 7: 0.2 }, winner: 5 },
  ])('argmax trên điểm lớp, không có objectness: $name', ({ main, also, winner }) => {
    const result = run([{ ...anchor(300, 300, 100, 100, 5, main), also }]);
    expect(result.map((d) => d.classId)).toEqual([winner]);
  });

  it('giữ confidence float32 gốc (không làm tròn), lấy frameId và timestamp từ meta, id = frameId-index', () => {
    const pp = createPostProcessor({ classMap: CLASS_MAP, inference: INFERENCE });
    const raw = makeRaw(64, 'channels_first', [anchor(100, 100, 50, 50, 2, 0.9), anchor(400, 400, 50, 50, 3, 0.6)]);
    const result = pp.process(raw, IDENTITY, { frameId: 7, width: 640, height: 640, timestamp: 1234.5 });
    expect(result.map((d) => d.id)).toEqual(['7-0', '7-1']);
    expect(confidences(result)).toEqual(float32([0.9, 0.6]));
    expect(result.every((d) => d.frameId === 7 && d.timestamp === 1234.5)).toBe(true);
  });
});

describe('ngưỡng confLow: so sánh nghiêm ngặt ở float32 (F2)', () => {
  it.each([
    { confLow: 0.25, score: 0.25, kept: false },
    { confLow: 0.25, score: 0.2500001, kept: true },
    { confLow: 0.25, score: 0.2499999, kept: false },
    { confLow: 0.3, score: 0.3, kept: false }, // 0,3 không biểu diễn đúng bằng float32: vẫn phải coi là "bằng"
    { confLow: 0.3, score: 0.31, kept: true },
  ])('confLow $confLow, điểm $score → giữ: $kept', ({ confLow, score, kept }) => {
    expect(run([anchor(300, 300, 100, 100, 4, score)], { inference: { confLow } })).toHaveLength(kept ? 1 : 0);
  });
});

describe('NMS (F4)', () => {
  const box = (cx: number, cls: number, score: number): Anchor => anchor(cx, 300, 200, 200, cls, score);
  const wide = (cx: number, score: number): Anchor => anchor(cx, 300, 100, 100, 4, score);
  it.each([
    { name: 'cùng lớp, IoU cao → giữ một (điểm cao hơn)', anchors: [box(300, 4, 0.8), box(310, 4, 0.9)], inference: {}, expected: [0.9] },
    { name: 'cùng lớp, IoU thấp → giữ cả hai', anchors: [box(300, 4, 0.9), box(450, 4, 0.8)], inference: {}, expected: [0.9, 0.8] },
    { name: 'khác lớp cùng vị trí, class-aware → giữ cả hai', anchors: [box(300, 4, 0.9), box(300, 6, 0.8)], inference: { agnosticNms: false }, expected: [0.9, 0.8] },
    { name: 'khác lớp cùng vị trí, agnostic → giữ một', anchors: [box(300, 4, 0.9), box(300, 6, 0.8)], inference: { agnosticNms: true }, expected: [0.9] },
    {
      name: 'IoU đúng bằng ngưỡng → giữ cả hai (chỉ loại khi IoU lớn hơn)',
      anchors: [wide(300, 0.9), anchor(300, 275, 100, 50, 4, 0.8)], // IoU = 5000 / 10000 = 0,5
      inference: { nmsIou: 0.5 },
      expected: [0.8, 0.9], // cùng tâm x nên theo tâm y: hộp thấp hơn (y nhỏ) đứng trước
    },
    {
      name: 'hộp đã bị loại không loại thêm hộp khác (A loại B, B không loại C)',
      anchors: [wide(100, 0.9), wide(140, 0.8), wide(180, 0.7)], // IoU(A,B) = IoU(B,C) = 0,43; IoU(A,C) = 0,11
      inference: { nmsIou: 0.4 },
      expected: [0.9, 0.7],
    },
  ])('$name', ({ anchors, inference, expected }) => {
    expect(confidences(run(anchors, { inference }))).toEqual(float32(expected));
  });
});

describe('bố cục tensor (F1)', () => {
  it('channels_last cho kết quả y hệt channels_first', () => {
    const scene = [
      anchor(100, 300, 80, 80, 0, 0.9),
      anchor(104, 300, 80, 80, 0, 0.7), // trùng hộp đầu, cùng lớp → NMS loại
      anchor(300, 300, 80, 80, 5, 0.6),
      anchor(500, 300, 80, 80, 2, 0.1), // dưới confLow
      anchor(500, 300, 80, 80, 8, 0.85),
    ];
    const first = run(scene, { layout: 'channels_first' });
    expect(first).toHaveLength(3);
    expect(run(scene, { layout: 'channels_last' })).toEqual(first);
  });

  it.each<{ name: string; layout: Layout; hint?: Layout }>([
    { name: 'không hint → channels_first', layout: 'channels_first' },
    { name: 'hint channels_last', layout: 'channels_last', hint: 'channels_last' },
  ])('dims [1, 13, 13] vừa là N = 13 vừa là 13 kênh, hoà bằng hint: $name', ({ layout, hint }) => {
    const pp = createPostProcessor({ classMap: CLASS_MAP, inference: INFERENCE, layoutHint: hint });
    const result = pp.process(makeRaw(13, layout, [anchor(300, 300, 100, 100, 4, 0.9)]), IDENTITY, frame());
    expect(result.map((d) => d.denomination)).toEqual([20000]);
  });

  it.each([
    { name: 'thiếu một lớp (12 kênh)', dims: [1, 12, 100], mention: ['13'] },
    { name: 'thừa một lớp (14 kênh)', dims: [1, 100, 14], mention: ['13'] },
    { name: 'batch khác 1', dims: [2, 13, 100], mention: [] },
    { name: 'thiếu chiều batch', dims: [13, 100], mention: [] },
    { name: 'thừa một chiều', dims: [1, 13, 100, 1], mention: [] },
    { name: 'N = 0', dims: [1, 13, 0], mention: [] },
    { name: 'dims không nguyên', dims: [1, 13, 100.5], mention: [] },
    { name: 'NMS nhúng sẵn [1, N, 6]', dims: [1, 300, 6], mention: ['nms=False'] },
  ])('dims sai ($name) → INFERENCE_FAILED nêu dims nhận được và mong đợi', ({ dims, mention }) => {
    const pp = createPostProcessor({ classMap: CLASS_MAP, inference: INFERENCE });
    const error = thrown(() => pp.process({ data: new Float32Array(0), dims }, IDENTITY, frame()));
    expect(error.code).toBe('INFERENCE_FAILED');
    expect(error.message).toContain(`[${dims.join(', ')}]`);
    expect(error.message).toContain('mong đợi');
    for (const text of mention) expect(error.message).toContain(text);
  });

  it('độ dài dữ liệu không khớp dims → INFERENCE_FAILED', () => {
    const pp = createPostProcessor({ classMap: CLASS_MAP, inference: INFERENCE });
    const error = thrown(() => pp.process({ data: new Float32Array(129), dims: [1, 13, 10] }, IDENTITY, frame()));
    expect(error.code).toBe('INFERENCE_FAILED');
    expect(error.message).toContain('129');
    expect(error.message).toContain('130');
  });

  it.each([
    { name: 'scale = 0', patch: { scale: 0 } },
    { name: 'scale NaN', patch: { scale: Number.NaN } },
    { name: 'scale vô cực', patch: { scale: Number.POSITIVE_INFINITY } },
    { name: 'ảnh gốc rộng 0', patch: { srcWidth: 0 } },
    { name: 'ảnh gốc cao âm', patch: { srcHeight: -480 } },
    { name: 'lề x vô cực', patch: { padX: Number.POSITIVE_INFINITY } },
    { name: 'lề y NaN', patch: { padY: Number.NaN } },
  ])('letterbox hỏng ($name) → INFERENCE_FAILED', ({ patch }) => {
    const pp = createPostProcessor({ classMap: CLASS_MAP, inference: INFERENCE });
    const raw = makeRaw(64, 'channels_first', [anchor(300, 300, 100, 100, 4, 0.9)]);
    expect(thrown(() => pp.process(raw, { ...IDENTITY, ...patch }, frame())).code).toBe('INFERENCE_FAILED');
  });

  it.each([
    { name: 'tâm x NaN', bad: anchor(Number.NaN, 50, 10, 10, 2, 0.9) },
    { name: 'rộng vô cực', bad: anchor(50, 50, Number.POSITIVE_INFINITY, 10, 2, 0.9) },
  ])('bỏ anchor có $name, anchor còn lại vẫn ra đúng', ({ bad }) => {
    expect(run([bad, anchor(300, 300, 100, 100, 3, 0.8)]).map((d) => d.classId)).toEqual([3]);
  });
});

describe('về khung hình gốc (F5)', () => {
  it('cắt hộp tràn khung; hộp nằm hẳn trong vùng lề bị loại', () => {
    const result = run(
      [
        anchor(20, 120, 100, 100, 0, 0.9), // x: -30..70, y: 70..170 → ảnh gốc y: -10..90
        anchor(620, 540, 100, 100, 1, 0.8), // x: 570..670, y: 490..590 → ảnh gốc y: 410..510
        anchor(320, 30, 100, 40, 2, 0.7), // y: 10..50 → ảnh gốc y: -70..-30, hẳn ngoài khung
      ],
      { letterbox: letterboxFor(640, 480, 640) }, // scale 1, lề trên/dưới 80
    );
    expect(result.map((d) => d.bbox)).toEqual([
      { x1: 0, y1: 0, x2: 70, y2: 90 },
      { x1: 570, y1: 410, x2: 640, y2: 480 },
    ]);
  });

  it.each(
    [
      { size: 416, anchors: 3549 },
      { size: 512, anchors: 5376 },
      { size: 640, anchors: 8400 },
    ].flatMap((s) => (['channels_first', 'channels_last'] as const).map((layout) => ({ ...s, layout }))),
  )('inputSize $size (N = $anchors, $layout): hộp gốc ra đúng, kể cả ở anchor cuối', ({ size, anchors, layout }) => {
    const lb = letterboxFor(1280, 720, size);
    const original = { x1: 400, y1: 200, x2: 800, y2: 400 };
    // Đặt hộp gốc vào ảnh vuông bằng phép letterbox thuận.
    const a = anchor(
      ((original.x1 + original.x2) / 2) * lb.scale + lb.padX,
      ((original.y1 + original.y2) / 2) * lb.scale + lb.padY,
      (original.x2 - original.x1) * lb.scale,
      (original.y2 - original.y1) * lb.scale,
      8,
      0.9,
    );
    const result = run([{ ...a, at: anchors - 1 }], { layout, letterbox: lb, count: anchors });
    expect(result).toHaveLength(1);
    expect(result[0]?.denomination).toBe(500000);
    expectBox(result[0]?.bbox, original, 3);
  });
});

describe('thứ tự và giới hạn (F3, F4, F7)', () => {
  it.each([
    {
      name: 'theo tâm x tăng dần',
      anchors: [anchor(500, 300, 80, 80, 0, 0.9), anchor(100, 300, 80, 80, 1, 0.8), anchor(300, 300, 80, 80, 2, 0.7)],
      expected: [10000, 100000, 1000],
    },
    {
      name: 'trùng tâm x thì theo tâm y',
      anchors: [anchor(300, 400, 80, 80, 0, 0.9), anchor(300, 100, 80, 80, 1, 0.8)],
      expected: [10000, 1000],
    },
  ])('sắp trái → phải: $name', ({ anchors, expected }) => {
    expect(run(anchors).map((d) => d.denomination)).toEqual(expected);
  });

  it('maxDetections chặn theo điểm (không theo vị trí), rồi mới sắp trái → phải', () => {
    const anchors = [0.5, 0.9, 0.6, 0.8, 0.7, 0.55].map((s, i) => anchor(50 + i * 100, 300, 60, 60, i, s));
    expect(confidences(run(anchors, { inference: { maxDetections: 3 } }))).toEqual(float32([0.9, 0.8, 0.7]));
  });

  it('maxDetections = 0 → luôn trả mảng rỗng', () => {
    expect(run([anchor(300, 300, 100, 100, 4, 0.9)], { inference: { maxDetections: 0 } })).toEqual([]);
  });

  it('chặn 300 ứng viên trước NMS: 400 hộp rời nhau chỉ còn 300 hộp điểm cao nhất', () => {
    const result = run(grid(400, (i) => 0.3 + i * 0.001), { count: 400, inference: { maxDetections: 1000 } });
    expect(result).toHaveLength(300);
    expect(Math.min(...confidences(result))).toBe(Math.fround(0.3 + 100 * 0.001)); // 100 hộp điểm thấp nhất bị loại
  });

  it('chặn 300 diễn ra TRƯỚC NMS: hộp xếp hạng sau 300 không được xét, dù NMS đã loại bớt hộp trong 300 đầu', () => {
    const anchors = [
      ...Array.from({ length: 150 }, (_, i) => cell(i, 0.9 - i * 0.0001)), // 150 hộp điểm cao nhất
      ...Array.from({ length: 150 }, (_, i) => cell(i, 0.8 - i * 0.0001, 1)), // sinh đôi lệch 1 px (IoU 0,82): NMS loại hết
      ...Array.from({ length: 50 }, (_, i) => cell(150 + i, 0.5)), // xếp hạng 301..350: phải bị bỏ
    ];
    expect(run(anchors, { count: 350, inference: { maxDetections: 1000 } })).toHaveLength(150);
  });

  it('hoà điểm khi bị chặn 300: giữ các anchor có chỉ số nhỏ hơn', () => {
    const result = run(grid(310, () => 0.5), { count: 310, inference: { maxDetections: 1000 } });
    expect(result).toHaveLength(300);
    expect(Math.max(...result.map((d) => d.bbox.y1))).toBe(5 + 14 * 30); // chỉ còn 15 hàng đầu (anchor 0..299)
  });
});

describe('classId lạ (F6)', () => {
  it.each([
    { name: 'lớp khuyết (undefined)', value: undefined },
    { name: 'giá trị không phải mệnh giá', value: 3000 },
  ])('$name → MODEL_CORRUPT', ({ value }) => {
    const classMap = CLASS_MAP.map((d, i) => (i === 4 ? (value as unknown as Denomination) : d));
    expect(thrown(() => run([anchor(300, 300, 100, 100, 4, 0.9)], { classMap })).code).toBe('MODEL_CORRUPT');
    expect(run([anchor(300, 300, 100, 100, 0, 0.9)], { classMap }).map((d) => d.denomination)).toEqual([1000]);
  });
});

describe('tái sử dụng bộ nhớ tạm (F8)', () => {
  it('kết quả mỗi khung không phụ thuộc các khung trước và không bị khung sau làm hỏng', () => {
    const single = makeRaw(64, 'channels_first', [anchor(300, 300, 80, 80, 3, 0.8)]);
    const frames = [
      makeRaw(64, 'channels_first', Array.from({ length: 5 }, (_, i) => anchor(60 + i * 120, 300, 80, 80, i, 0.9 - i * 0.1))),
      single,
      makeRaw(400, 'channels_last', grid(350, (i) => 0.3 + i * 0.001)), // nhiều anchor và ứng viên hơn mọi khung trước
      single,
      makeRaw(64, 'channels_first', []),
    ];
    const pp = createPostProcessor({ classMap: CLASS_MAP, inference: INFERENCE });
    const results: Detection[][] = [];
    const snapshots: Detection[][] = [];
    frames.forEach((raw, i) => {
      results.push(pp.process(raw, IDENTITY, frame(i)));
      snapshots.push(structuredClone(results[i] ?? []));
    });
    expect(results.map((r) => r.length)).toEqual([5, 1, INFERENCE.maxDetections, 1, 0]);
    frames.forEach((raw, i) => {
      const fresh = createPostProcessor({ classMap: CLASS_MAP, inference: INFERENCE });
      expect(results[i]).toEqual(snapshots[i]); // Detection đã trả về không dùng chung bộ nhớ với khung sau
      expect(results[i]).toEqual(fresh.process(raw, IDENTITY, frame(i))); // bộ nhớ cũ không ảnh hưởng khung sau
    });
  });
});

describe('cấu hình không hợp lệ', () => {
  it.each([
    { name: 'nmsIou NaN', inference: { nmsIou: Number.NaN } },
    { name: 'nmsIou > 1', inference: { nmsIou: 1.5 } },
    { name: 'nmsIou âm', inference: { nmsIou: -0.1 } },
    { name: 'maxDetections âm', inference: { maxDetections: -1 } },
    { name: 'maxDetections không nguyên', inference: { maxDetections: 2.5 } },
    { name: 'confLow NaN', inference: { confLow: Number.NaN } },
  ])('$name → INFERENCE_FAILED', ({ inference }) => {
    const error = thrown(() => createPostProcessor({ classMap: CLASS_MAP, inference: { ...INFERENCE, ...inference } }));
    expect(error.code).toBe('INFERENCE_FAILED');
  });

  it('classMap rỗng → MODEL_CORRUPT', () => {
    expect(thrown(() => createPostProcessor({ classMap: [], inference: INFERENCE })).code).toBe('MODEL_CORRUPT');
  });
});

describe('khớp bản mẫu numpy ở P01 (CELL 5)', () => {
  it('cảnh 1000×750 → S=640: số kỳ vọng do chính giai_ma, nms_theo_lop, tra_ve_anh_goc của notebook tính ra', () => {
    // CELL 5 cho letterbox: scale 0,64; newW 640; newH 480; lề (0, 80).
    const scene = [
      anchor(301.37, 287.91, 88.13, 141.77, 3, 0.8731), // A
      anchor(305.02, 290.48, 90.11, 139.2, 3, 0.6118), // B: trùm A, cùng lớp → NMS loại
      anchor(299.5, 289, 86, 140, 6, 0.5517), // C: trùm A, khác lớp → giữ (và đứng trước A vì tâm x nhỏ hơn)
      anchor(511.83, 402.6, 120.4, 70.9, 8, 0.9242), // D
      anchor(150, 300, 50, 50, 1, 0.2), // E: dưới confLow
      anchor(40.3, 95.2, 110.5, 60.6, 0, 0.7005), // F: tràn lề trái và lề trên
      anchor(610.2, 540.7, 80.3, 60.9, 5, 0.4417), // G: tràn lề phải và lề dưới
    ];
    const expected = [
      { classId: 0, denomination: 1000, score: 0.7005, bbox: { x1: 0, y1: 0, x2: 149.2968797684, y2: 71.09375 } },
      { classId: 6, denomination: 5000, score: 0.5517, bbox: { x1: 400.78125, y1: 217.1875, x2: 535.15625, y2: 435.9375 } },
      { classId: 3, denomination: 2000, score: 0.8731, bbox: { x1: 402.0390510559, y1: 214.1015529633, x2: 539.7421836853, y2: 435.6172084808 } },
      { classId: 8, denomination: 500000, score: 0.9242, bbox: { x1: 705.6718349457, y1: 448.6718654633, x2: 893.7968254089, y2: 559.4531536102 } },
      { classId: 5, denomination: 200000, score: 0.4417, bbox: { x1: 890.7031059265, y1: 672.265625, x2: 1000, y2: 750 } },
    ];
    const result = run(scene, { letterbox: letterboxFor(1000, 750, 640), count: 40 });
    expect(result.map((d) => [d.classId, d.denomination, d.confidence])).toEqual(
      expected.map((e) => [e.classId, e.denomination, Math.fround(e.score)]),
    );
    // Sai số 5e-9: đủ chặt để phát hiện việc bỏ ép toạ độ về float32 (lệch cỡ 1e-5 ở các hộp này).
    result.forEach((d, i) => expectBox(d.bbox, expected[i]?.bbox ?? { x1: 0, y1: 0, x2: 0, y2: 0 }, 8));
  });
});