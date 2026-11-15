import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import { AppError } from '../../src/contracts';
import type {
  AppErrorCode,
  Detection,
  FrameMeta,
  IPostProcessor,
  IPreprocessor,
  LetterboxMeta,
  ModelInfo,
  RawModelOutput,
  WorkerRequest,
  WorkerResponse,
} from '../../src/contracts';
import { clearRecentLogs, setLogLevel, setLogSink } from '../../src/utils/logger';
import { createFakeClock } from '../../src/utils/time';
import type { ModelRunner } from '../../src/vision/model-manager';
import { closeBitmap, createWorkerCore } from '../../src/vision/worker-core';
import { makeDetection, makeFakeBitmap, makeFrameMeta, makeGray } from '../fakes';

const INFO: ModelInfo = { version: '9.9.9', inputSize: 4, classCount: 9, backend: 'wasm', threads: 1, loadMs: 10, warmupMs: 5 };
const LETTERBOX: LetterboxMeta = { inputSize: 4, srcWidth: 640, srcHeight: 480, scale: 0.00625, newWidth: 4, newHeight: 3, padX: 0, padY: 0 };
const TENSOR = new Float32Array(3 * 4 * 4);
const RAW: RawModelOutput = { data: new Float32Array([1, 2, 3]), dims: [1, 3] };
const GRAY = makeGray(8, 6);

/** Khung giả kèm bộ đếm số lần bitmap bị đóng. */
function makeFrame(frameId = 1): { meta: FrameMeta; bitmap: ImageBitmap; closed(): number } {
  let closes = 0;
  return { meta: makeFrameMeta({ frameId }), bitmap: makeFakeBitmap(640, 480, () => (closes += 1)), closed: () => closes };
}

const inferRequest = (frame: { meta: FrameMeta; bitmap: ImageBitmap }): WorkerRequest => ({ type: 'INFER', meta: frame.meta, bitmap: frame.bitmap });

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function defer<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Rig {
  core: ReturnType<typeof createWorkerCore>;
  clock: ReturnType<typeof createFakeClock>;
  preprocess: ReturnType<typeof vi.fn>;
  predict: ReturnType<typeof vi.fn>;
  postprocess: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface RigOptions {
  preprocessError?: Error;
  predictImpl?: (tensor: Float32Array) => Promise<RawModelOutput>;
  postprocessImpl?: () => Detection[];
  disposeError?: Error;
  /** Mỗi bước tiêu tốn bao nhiêu ms trên đồng hồ giả. */
  cost?: { pre: number; infer: number; post: number };
}

/** Lõi worker dựng từ đồ giả; mỗi bước "tốn" thời gian bằng cách đẩy đồng hồ giả. */
function makeRig(options: RigOptions = {}): Rig {
  const clock = createFakeClock(1000);
  const cost = options.cost ?? { pre: 0, infer: 0, post: 0 };
  const preprocess = vi.fn(() => {
    if (options.preprocessError) throw options.preprocessError;
    clock.advance(cost.pre);
    return { tensor: TENSOR, letterbox: LETTERBOX, gray: GRAY };
  });
  const predict = vi.fn(async (tensor: Float32Array) => {
    if (options.predictImpl) return options.predictImpl(tensor);
    clock.advance(cost.infer);
    return RAW;
  });
  const postprocess = vi.fn(() => {
    clock.advance(cost.post);
    return options.postprocessImpl ? options.postprocessImpl() : [];
  });
  const dispose = vi.fn(async () => {
    if (options.disposeError) throw options.disposeError;
  });
  const model: ModelRunner = { info: INFO, predict, dispose };
  const preprocessor: IPreprocessor = { process: preprocess };
  const postProcessor: IPostProcessor = { process: postprocess };
  return { core: createWorkerCore({ model, preprocessor, postProcessor, now: clock.now }), clock, preprocess, predict, postprocess, dispose };
}

beforeEach(() => {
  setLogLevel('debug');
  setLogSink(() => undefined);
  clearRecentLogs();
});

/** Thu hẹp WorkerResponse theo type để test truy cập trường mà không ép kiểu. */
function expectType<T extends WorkerResponse['type']>(response: WorkerResponse | null, type: T): Extract<WorkerResponse, { type: T }> {
  expect(response?.type).toBe(type);
  return response as Extract<WorkerResponse, { type: T }>;
}

describe('createWorkerCore › INFER thành công', () => {
  it('RESULT mang đúng meta, ảnh xám và timings từng giai đoạn đo bằng đồng hồ tiêm vào', async () => {
    const rig = makeRig({ cost: { pre: 3, infer: 20, post: 2 } });
    const frame = makeFrame(7);
    const { result } = expectType(await rig.core.handle(inferRequest(frame)), 'RESULT');
    expect(result.meta).toBe(frame.meta);
    expect(result.gray).toBe(GRAY);
    expect(result.timings).toEqual({ preprocessMs: 3, inferMs: 20, postprocessMs: 2, totalMs: 25 });
  });

  it('chuyển tensor tiền xử lý cho mô hình, rồi đầu ra mô hình + letterbox + meta cho hậu xử lý', async () => {
    const rig = makeRig();
    const frame = makeFrame(4);
    await rig.core.handle(inferRequest(frame));
    expect(rig.preprocess).toHaveBeenCalledWith(frame.bitmap);
    expect(rig.predict).toHaveBeenCalledWith(TENSOR);
    expect(rig.postprocess).toHaveBeenCalledWith(RAW, LETTERBOX, frame.meta);
  });

  it('sắp detection từ trái sang phải theo tâm x (hòa thì theo y) mà không sửa mảng của hậu xử lý', async () => {
    const at = (id: string, x1: number, y1: number): Detection =>
      makeDetection({ id, bbox: { x1, y1, x2: x1 + 100, y2: y1 + 100 } });
    const right = at('right', 400, 0);
    const lowLeft = at('low-left', 50, 200);
    const highLeft = at('high-left', 50, 20);
    const fromPost = [right, lowLeft, highLeft];
    const rig = makeRig({ postprocessImpl: () => fromPost });
    const { result } = expectType(await rig.core.handle(inferRequest(makeFrame())), 'RESULT');
    expect(result.detections.map((d) => d.id)).toEqual(['high-left', 'low-left', 'right']);
    expect(fromPost.map((d) => d.id)).toEqual(['right', 'low-left', 'high-left']);
  });

  it('khung không có tiền vẫn là RESULT với danh sách rỗng', async () => {
    const { result } = expectType(await makeRig().core.handle(inferRequest(makeFrame())), 'RESULT');
    expect(result.detections).toEqual([]);
  });

  it('đóng bitmap đúng một lần ngay sau tiền xử lý, trước khi chờ ONNX', async () => {
    const gate = defer<RawModelOutput>();
    const rig = makeRig({ predictImpl: () => gate.promise });
    const frame = makeFrame();
    const pending = rig.core.handle(inferRequest(frame));
    expect(rig.preprocess).toHaveBeenCalledTimes(1);
    expect(frame.closed()).toBe(1); // ONNX chưa trả về mà bitmap đã được giải phóng
    gate.resolve(RAW);
    expectType(await pending, 'RESULT');
    expect(frame.closed()).toBe(1);
  });

  it('bitmap.close() ném lỗi cũng không làm hỏng kết quả', async () => {
    const bitmap = { width: 1, height: 1, close: () => { throw new Error('đã đóng'); } } as unknown as ImageBitmap;
    expectType(await makeRig().core.handle({ type: 'INFER', meta: makeFrameMeta(), bitmap }), 'RESULT');
  });
});

describe('createWorkerCore › bitmap được đóng ở MỌI nhánh', () => {
  const branches: Array<{ name: string; options: RigOptions; expected: WorkerResponse['type'] }> = [
    { name: 'thành công', options: {}, expected: 'RESULT' },
    { name: 'tiền xử lý ném lỗi', options: { preprocessError: new Error('canvas lỗi') }, expected: 'ERROR' },
    { name: 'ONNX ném lỗi', options: { predictImpl: async () => { throw new Error('ORT lỗi'); } }, expected: 'ERROR' },
    { name: 'hậu xử lý ném lỗi', options: { postprocessImpl: () => { throw new Error('NMS lỗi'); } }, expected: 'ERROR' },
  ];

  it.each(branches)('$name → $expected, bitmap đóng đúng 1 lần', async ({ options, expected }) => {
    const frame = makeFrame();
    expectType(await makeRig(options).core.handle(inferRequest(frame)), expected);
    expect(frame.closed()).toBe(1);
  });

  it('khung bị DROPPED vì bận → bitmap của khung đó đóng đúng 1 lần', async () => {
    const gate = defer<RawModelOutput>();
    const rig = makeRig({ predictImpl: () => gate.promise });
    const first = makeFrame(1);
    const second = makeFrame(2);
    const pending = rig.core.handle(inferRequest(first));
    expectType(await rig.core.handle(inferRequest(second)), 'DROPPED');
    expect(second.closed()).toBe(1);
    gate.resolve(RAW);
    await pending;
    expect(first.closed()).toBe(1);
    expect(second.closed()).toBe(1);
  });

  it('khung đến sau DISPOSE → DROPPED, bitmap đóng đúng 1 lần, không chạm tiền xử lý', async () => {
    const rig = makeRig();
    await rig.core.handle({ type: 'DISPOSE' });
    const frame = makeFrame();
    expectType(await rig.core.handle(inferRequest(frame)), 'DROPPED');
    expect(frame.closed()).toBe(1);
    expect(rig.preprocess).not.toHaveBeenCalled();
  });
});

describe('createWorkerCore › chỉ xử lý một khung một lúc', () => {
  it('khung đến khi đang bận → DROPPED kèm frameId; xong việc thì nhận khung tiếp theo bình thường', async () => {
    const gate = defer<RawModelOutput>();
    let calls = 0;
    const rig = makeRig({ predictImpl: () => (++calls === 1 ? gate.promise : Promise.resolve(RAW)) });
    const pending = rig.core.handle(inferRequest(makeFrame(1)));
    const dropped = expectType(await rig.core.handle(inferRequest(makeFrame(2))), 'DROPPED');
    expect(dropped.frameId).toBe(2);
    gate.resolve(RAW);
    expect(expectType(await pending, 'RESULT').result.meta.frameId).toBe(1);
    expect(expectType(await rig.core.handle(inferRequest(makeFrame(3))), 'RESULT').result.meta.frameId).toBe(3);
    expect(rig.predict).toHaveBeenCalledTimes(2); // khung 2 không bao giờ vào ONNX
  });

  it('cờ bận được đặt đồng bộ: hai yêu cầu liền nhau trong cùng một nhịp thì yêu cầu thứ hai bị DROPPED', async () => {
    const rig = makeRig();
    const [first, second] = await Promise.all([rig.core.handle(inferRequest(makeFrame(1))), rig.core.handle(inferRequest(makeFrame(2)))]);
    expect(first?.type).toBe('RESULT');
    expect(second?.type).toBe('DROPPED');
  });

  it('khung đang bay lỗi thì cờ bận được nhả: khung kế tiếp không bị DROPPED oan', async () => {
    let calls = 0;
    const rig = makeRig({ predictImpl: async () => { if (++calls === 1) throw new Error('lỗi một lần'); return RAW; } });
    expectType(await rig.core.handle(inferRequest(makeFrame(1))), 'ERROR');
    expectType(await rig.core.handle(inferRequest(makeFrame(2))), 'RESULT');
  });
});

describe('createWorkerCore › lỗi từng khung không làm chết lõi', () => {
  it('lỗi thường → ERROR không fatal, mã INFERENCE_FAILED, kèm frameId; khung sau vẫn ra RESULT', async () => {
    let calls = 0;
    const rig = makeRig({ predictImpl: async () => { if (++calls === 1) throw new TypeError('bộ nhớ hỏng'); return RAW; } });
    const error = expectType(await rig.core.handle(inferRequest(makeFrame(5))), 'ERROR');
    expect(error).toMatchObject({ code: 'INFERENCE_FAILED', fatal: false, frameId: 5 });
    expect(error.message).toContain('bộ nhớ hỏng');
    expect(expectType(await rig.core.handle(inferRequest(makeFrame(6))), 'RESULT').result.meta.frameId).toBe(6);
  });

  it.each<AppErrorCode>(['MODEL_CORRUPT', 'INFERENCE_FAILED', 'MODEL_INIT_FAILED'])('AppError mã %s được giữ nguyên mã và vẫn không fatal', async (code) => {
    const rig = makeRig({ predictImpl: async () => { throw new AppError(code, 'x', true); } });
    const error = expectType(await rig.core.handle(inferRequest(makeFrame(8))), 'ERROR');
    expect(error).toMatchObject({ code, fatal: false, frameId: 8 });
  });

  it('giá trị ném ra không phải Error vẫn thành ERROR có thông điệp', async () => {
    const rig = makeRig({ predictImpl: async () => Promise.reject('chuỗi trần') });
    const error = expectType(await rig.core.handle(inferRequest(makeFrame())), 'ERROR');
    expect(error.message).toContain('chuỗi trần');
  });

  it('tiền xử lý lỗi thì không gọi ONNX', async () => {
    const rig = makeRig({ preprocessError: new Error('canvas lỗi') });
    expectType(await rig.core.handle(inferRequest(makeFrame())), 'ERROR');
    expect(rig.predict).not.toHaveBeenCalled();
  });
});

describe('createWorkerCore › INIT và DISPOSE', () => {
  it('INIT → READY mang ModelInfo của mô hình đã nạp', async () => {
    expect(expectType(await makeRig().core.handle({ type: 'INIT', modelBaseUrl: 'm/', ortBaseUrl: 'o/', config: DEFAULT_CONFIG.inference }), 'READY').info).toBe(INFO);
  });

  it('DISPOSE không có phản hồi (null) và giải phóng mô hình đúng một lần dù gọi lặp', async () => {
    const rig = makeRig();
    expect(await rig.core.handle({ type: 'DISPOSE' })).toBeNull();
    expect(await rig.core.handle({ type: 'DISPOSE' })).toBeNull();
    expect(rig.dispose).toHaveBeenCalledTimes(1);
  });

  it('giải phóng mô hình lỗi vẫn trả null, không ném', async () => {
    const rig = makeRig({ disposeError: new Error('session đã chết') });
    await expect(rig.core.handle({ type: 'DISPOSE' })).resolves.toBeNull();
  });
});

describe('closeBitmap', () => {
  it('đóng bitmap; gọi lại không gây lỗi', () => {
    const frame = makeFrame();
    closeBitmap(frame.bitmap);
    closeBitmap(frame.bitmap);
    expect(frame.closed()).toBe(1);
  });

  it('nuốt lỗi của close()', () => {
    const bitmap = { close: () => { throw new Error('x'); } } as unknown as ImageBitmap;
    expect(() => closeBitmap(bitmap)).not.toThrow();
  });
});