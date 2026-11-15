import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import { AppError } from '../../src/contracts';
import type { AppErrorCode, CapturedFrame, ModelInfo, WorkerRequest, WorkerResponse } from '../../src/contracts';
import { clearRecentLogs, setLogLevel, setLogSink } from '../../src/utils/logger';
import { createInferenceClient } from '../../src/vision/inference-client';
import type { InferenceClientOptions } from '../../src/vision/inference-client';
import { makeFakeBitmap, makeFrameMeta, makeInferenceResult } from '../fakes';

const INFO: ModelInfo = { version: '9.9.9', inputSize: 640, classCount: 9, backend: 'wasm', threads: 1, loadMs: 120, warmupMs: 40 };

/** Web Worker giả: ghi lại thông điệp gửi đi; test chủ động "đẩy" phản hồi hoặc làm worker chết. */
class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly posted: Array<{ message: WorkerRequest; transfer: Transferable[] | undefined }> = [];
  terminated = 0;
  postError: Error | null = null;

  postMessage(message: WorkerRequest, transfer?: Transferable[]): void {
    if (this.postError && message.type === 'INFER') throw this.postError;
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** Worker gửi phản hồi về main thread (không làm gì nếu client đã gỡ onmessage, như worker thật đã bị terminate). */
  emit(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }

  /** Worker chết bất ngờ (script lỗi, hết bộ nhớ...). */
  die(message = 'Uncaught Error: boom'): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  get infers(): WorkerRequest[] {
    return this.posted.map((p) => p.message).filter((m) => m.type === 'INFER');
  }
}

interface Rig {
  client: ReturnType<typeof createInferenceClient>;
  workers: FakeWorker[];
  worker(): FakeWorker;
}

function makeRig(over: Partial<InferenceClientOptions> = {}): Rig {
  const workers: FakeWorker[] = [];
  const client = createInferenceClient({
    modelBaseUrl: 'models',
    ortBaseUrl: 'ort',
    config: DEFAULT_CONFIG.inference,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    ...over,
  });
  return {
    client,
    workers,
    worker: () => {
      const last = workers[workers.length - 1];
      if (!last) throw new Error('Chưa có worker nào được tạo');
      return last;
    },
  };
}

/** Client đã init xong (worker đã báo READY). */
async function makeReadyRig(): Promise<Rig> {
  const rig = makeRig();
  const initPromise = rig.client.init();
  rig.worker().emit({ type: 'READY', info: INFO });
  await initPromise;
  return rig;
}

/** Khung giả kèm bộ đếm số lần client đóng bitmap. */
function makeFrame(frameId = 1): { frame: CapturedFrame; closed(): number } {
  let closes = 0;
  const bitmap = makeFakeBitmap(640, 480, () => (closes += 1));
  return { frame: { bitmap, meta: makeFrameMeta({ frameId }) }, closed: () => closes };
}

const resultFor = (frameId: number): WorkerResponse => ({ type: 'RESULT', result: makeInferenceResult({ meta: makeFrameMeta({ frameId }) }) });

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

async function expectCode(promise: Promise<unknown>, code: AppErrorCode): Promise<AppError> {
  const error = await rejection(promise);
  expect(error.code).toBe(code);
  return error;
}

beforeEach(() => {
  setLogLevel('debug');
  setLogSink(() => undefined);
  clearRecentLogs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createInferenceClient › init', () => {
  it('gửi INIT một lần với cấu hình suy luận; READY thì init trả ModelInfo và ready = true', async () => {
    const rig = makeRig();
    expect(rig.client.ready).toBe(false);
    const initPromise = rig.client.init();
    expect(rig.worker().posted).toHaveLength(1);
    expect(rig.worker().posted[0]?.message).toEqual({ type: 'INIT', modelBaseUrl: 'models/', ortBaseUrl: 'ort/', config: DEFAULT_CONFIG.inference });
    expect(rig.client.ready).toBe(false); // chưa có READY
    rig.worker().emit({ type: 'READY', info: INFO });
    await expect(initPromise).resolves.toBe(INFO);
    expect(rig.client.ready).toBe(true);
  });

  it.each([
    { base: 'https://localhost/index.html', input: 'models', expected: 'https://localhost/models/' },
    { base: 'https://localhost/index.html', input: 'models/', expected: 'https://localhost/models/' },
    { base: 'https://localhost/app/index.html', input: 'ort', expected: 'https://localhost/app/ort/' },
    { base: 'https://localhost/index.html', input: '/ort', expected: 'https://localhost/ort/' },
    { base: 'https://localhost/index.html', input: 'https://cdn.test/ort', expected: 'https://cdn.test/ort/' },
  ])('URL "$input" so với trang $base → $expected (worker hiểu URL tương đối theo file worker nên phải đổi sang tuyệt đối)', ({ base, input, expected }) => {
    vi.stubGlobal('document', { baseURI: base });
    const rig = makeRig({ modelBaseUrl: input, ortBaseUrl: input });
    void rig.client.init();
    expect(rig.worker().posted[0]?.message).toMatchObject({ modelBaseUrl: expected, ortBaseUrl: expected });
  });

  it('không có document (Node/worker) thì chỉ bảo đảm dấu / ở cuối', () => {
    const rig = makeRig({ modelBaseUrl: 'a/b', ortBaseUrl: 'c/' });
    void rig.client.init();
    expect(rig.worker().posted[0]?.message).toMatchObject({ modelBaseUrl: 'a/b/', ortBaseUrl: 'c/' });
  });

  it('gọi init nhiều lần chỉ tạo một worker và trả cùng một lời hứa', async () => {
    const rig = makeRig();
    const first = rig.client.init();
    const second = rig.client.init();
    expect(second).toBe(first);
    expect(rig.workers).toHaveLength(1);
    rig.worker().emit({ type: 'READY', info: INFO });
    await first;
    expect(rig.client.init()).toBe(first);
    expect(rig.workers).toHaveLength(1);
  });

  it.each([{ fatal: true }, { fatal: false }])('worker báo ERROR (fatal=$fatal) khi đang khởi tạo → init bị từ chối bằng AppError đúng mã, worker bị dừng', async ({ fatal }) => {
    const rig = makeRig();
    const initPromise = rig.client.init();
    rig.worker().emit({ type: 'ERROR', code: 'MODEL_MISSING', message: 'Thiếu mô hình', fatal });
    const error = await expectCode(initPromise, 'MODEL_MISSING');
    expect(error.message).toBe('Thiếu mô hình');
    expect(rig.worker().terminated).toBe(1);
    expect(rig.client.ready).toBe(false);
  });

  it('init thất bại thì gọi init lại sẽ tạo worker mới (cho phép thử lại)', async () => {
    const rig = makeRig();
    const first = rig.client.init();
    rig.worker().emit({ type: 'ERROR', code: 'MODEL_INIT_FAILED', message: 'x', fatal: true });
    await rejection(first);
    const second = rig.client.init();
    expect(rig.workers).toHaveLength(2);
    rig.worker().emit({ type: 'READY', info: INFO });
    await expect(second).resolves.toBe(INFO);
  });

  it('quá 30 giây chưa READY → MODEL_INIT_FAILED (fatal) và dừng worker', async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    const assertion = expectCode(rig.client.init(), 'MODEL_INIT_FAILED');
    vi.advanceTimersByTime(29_999);
    expect(rig.worker().terminated).toBe(0);
    vi.advanceTimersByTime(1);
    const error = await assertion;
    expect(error.fatal).toBe(true);
    expect(rig.worker().terminated).toBe(1);
    expect(rig.client.ready).toBe(false);
  });

  it('READY đến kịp thì bộ đếm 30 giây bị hủy: worker không bị dừng sau đó', async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    const initPromise = rig.client.init();
    rig.worker().emit({ type: 'READY', info: INFO });
    await initPromise;
    vi.advanceTimersByTime(60_000);
    expect(rig.worker().terminated).toBe(0);
    expect(rig.client.ready).toBe(true);
  });

  it('không tạo được worker → MODEL_INIT_FAILED', async () => {
    const rig = makeRig({
      workerFactory: () => {
        throw new Error('Worker bị chặn');
      },
    });
    await expectCode(rig.client.init(), 'MODEL_INIT_FAILED');
  });

  it('worker chết khi đang khởi tạo → MODEL_INIT_FAILED (fatal)', async () => {
    const rig = makeRig();
    const initPromise = rig.client.init();
    rig.worker().die('Failed to fetch dynamically imported module');
    const error = await expectCode(initPromise, 'MODEL_INIT_FAILED');
    expect(error.fatal).toBe(true);
    expect(error.message).toContain('Failed to fetch dynamically imported module');
    expect(rig.worker().terminated).toBe(1);
  });

  it('READY thừa (không có init đang chờ) bị bỏ qua', async () => {
    const rig = await makeReadyRig();
    rig.worker().emit({ type: 'READY', info: { ...INFO, version: 'khác' } });
    expect(rig.client.ready).toBe(true);
  });
});

describe('createInferenceClient › infer', () => {
  it('chuyển quyền sở hữu bitmap sang worker (transfer list) và không tự đóng nó; RESULT thì resolve đúng kết quả', async () => {
    const rig = await makeReadyRig();
    const { frame, closed } = makeFrame(11);
    const pending = rig.client.infer(frame);
    const sent = rig.worker().posted[1];
    expect(sent?.message).toEqual({ type: 'INFER', meta: frame.meta, bitmap: frame.bitmap });
    expect(sent?.transfer).toEqual([frame.bitmap]);
    const response = resultFor(11);
    rig.worker().emit(response);
    await expect(pending).resolves.toBe(response.type === 'RESULT' ? response.result : null);
    expect(closed()).toBe(0); // worker chịu trách nhiệm đóng
  });

  it('DROPPED của đúng khung → resolve null', async () => {
    const rig = await makeReadyRig();
    const pending = rig.client.infer(makeFrame(3).frame);
    rig.worker().emit({ type: 'DROPPED', frameId: 3 });
    await expect(pending).resolves.toBeNull();
  });

  it('ERROR không fatal của khung → từ chối bằng AppError đúng mã; client vẫn dùng tiếp được', async () => {
    const rig = await makeReadyRig();
    const first = rig.client.infer(makeFrame(4).frame);
    rig.worker().emit({ type: 'ERROR', code: 'INFERENCE_FAILED', message: 'Khung hỏng', fatal: false, frameId: 4 });
    const error = await expectCode(first, 'INFERENCE_FAILED');
    expect(error.fatal).toBe(false);
    expect(rig.client.ready).toBe(true);
    expect(rig.worker().terminated).toBe(0);
    const second = rig.client.infer(makeFrame(5).frame);
    rig.worker().emit(resultFor(5));
    await expect(second).resolves.toMatchObject({ meta: { frameId: 5 } });
  });

  it('ERROR fatal khi đang chạy → từ chối khung đang chờ, dừng worker, ready = false', async () => {
    const rig = await makeReadyRig();
    const pending = rig.client.infer(makeFrame(6).frame);
    rig.worker().emit({ type: 'ERROR', code: 'MODEL_CORRUPT', message: 'Hỏng', fatal: true, frameId: 6 });
    const error = await expectCode(pending, 'MODEL_CORRUPT');
    expect(error.fatal).toBe(true);
    expect(rig.worker().terminated).toBe(1);
    expect(rig.client.ready).toBe(false);
  });

  it('ERROR không fatal và không kèm frameId chỉ được ghi log: khung đang chờ vẫn chờ tiếp', async () => {
    const rig = await makeReadyRig();
    const pending = rig.client.infer(makeFrame(7).frame);
    rig.worker().emit({ type: 'ERROR', code: 'INFERENCE_FAILED', message: 'chung chung', fatal: false });
    rig.worker().emit(resultFor(7));
    await expect(pending).resolves.toMatchObject({ meta: { frameId: 7 } });
  });

  it('chỉ một khung bay cùng lúc: khung thứ hai → null và bitmap của nó được đóng; khung đầu vẫn nguyên', async () => {
    const rig = await makeReadyRig();
    const first = makeFrame(1);
    const second = makeFrame(2);
    const firstPending = rig.client.infer(first.frame);
    await expect(rig.client.infer(second.frame)).resolves.toBeNull();
    expect(second.closed()).toBe(1);
    expect(first.closed()).toBe(0);
    expect(rig.worker().infers).toHaveLength(1);
    rig.worker().emit(resultFor(1));
    await expect(firstPending).resolves.toMatchObject({ meta: { frameId: 1 } });
    const third = rig.client.infer(makeFrame(3).frame); // chỗ đã trống
    rig.worker().emit(resultFor(3));
    await expect(third).resolves.toMatchObject({ meta: { frameId: 3 } });
    expect(rig.worker().infers).toHaveLength(2);
  });

  it('phản hồi của khung khác (lạc/muộn) bị bỏ qua, không làm xong nhầm khung đang chờ', async () => {
    const rig = await makeReadyRig();
    const pending = rig.client.infer(makeFrame(8).frame);
    let settled = false;
    void pending.then(() => (settled = true), () => (settled = true));
    rig.worker().emit(resultFor(99));
    rig.worker().emit({ type: 'DROPPED', frameId: 98 });
    await Promise.resolve();
    expect(settled).toBe(false);
    rig.worker().emit(resultFor(8));
    await expect(pending).resolves.toMatchObject({ meta: { frameId: 8 } });
  });

  it('infer trước init → INFERENCE_FAILED và bitmap vẫn được đóng', async () => {
    const rig = makeRig();
    const { frame, closed } = makeFrame();
    await expectCode(rig.client.infer(frame), 'INFERENCE_FAILED');
    expect(closed()).toBe(1);
    expect(rig.workers).toHaveLength(0);
  });

  it('infer khi init còn đang chạy (chưa READY) → từ chối và đóng bitmap', async () => {
    const rig = makeRig();
    void rig.client.init().catch(() => undefined);
    const { frame, closed } = makeFrame();
    await expectCode(rig.client.infer(frame), 'INFERENCE_FAILED');
    expect(closed()).toBe(1);
    expect(rig.worker().infers).toHaveLength(0);
  });

  it('postMessage ném lỗi → INFERENCE_FAILED không fatal, bitmap được đóng, chỗ bay được nhả', async () => {
    const rig = await makeReadyRig();
    rig.worker().postError = new Error('DataCloneError');
    const failed = makeFrame(1);
    const error = await expectCode(rig.client.infer(failed.frame), 'INFERENCE_FAILED');
    expect(error.fatal).toBe(false);
    expect(failed.closed()).toBe(1);
    rig.worker().postError = null;
    const next = rig.client.infer(makeFrame(2).frame);
    rig.worker().emit(resultFor(2));
    await expect(next).resolves.toMatchObject({ meta: { frameId: 2 } });
  });
});

describe('createInferenceClient › worker chết', () => {
  it('worker chết khi có khung đang chờ → khung bị từ chối INFERENCE_FAILED (fatal), ready = false, worker bị dừng', async () => {
    const rig = await makeReadyRig();
    const pending = rig.client.infer(makeFrame(1).frame);
    rig.worker().die('out of memory');
    const error = await expectCode(pending, 'INFERENCE_FAILED');
    expect(error.fatal).toBe(true);
    expect(error.message).toContain('out of memory');
    expect(rig.client.ready).toBe(false);
    expect(rig.worker().terminated).toBe(1);
  });

  it('worker chết khi rảnh → ready = false; infer sau đó bị từ chối và đóng bitmap', async () => {
    const rig = await makeReadyRig();
    rig.worker().die();
    expect(rig.client.ready).toBe(false);
    const { frame, closed } = makeFrame();
    await expectCode(rig.client.infer(frame), 'INFERENCE_FAILED');
    expect(closed()).toBe(1);
  });

  it('onmessageerror (không đọc được thông điệp) cũng được coi là worker chết', async () => {
    const rig = await makeReadyRig();
    const pending = rig.client.infer(makeFrame(1).frame);
    rig.worker().onmessageerror?.({} as MessageEvent);
    await expectCode(pending, 'INFERENCE_FAILED');
    expect(rig.client.ready).toBe(false);
  });

  it('sau khi worker chết có thể init lại để hồi phục', async () => {
    const rig = await makeReadyRig();
    rig.worker().die();
    const again = rig.client.init();
    expect(rig.workers).toHaveLength(2);
    rig.worker().emit({ type: 'READY', info: INFO });
    await expect(again).resolves.toBe(INFO);
    expect(rig.client.ready).toBe(true);
  });
});

describe('createInferenceClient › dispose', () => {
  it('dừng worker, ready = false; khung đang chờ resolve null (không phải lỗi)', async () => {
    const rig = await makeReadyRig();
    const pending = rig.client.infer(makeFrame(1).frame);
    rig.client.dispose();
    await expect(pending).resolves.toBeNull();
    expect(rig.worker().terminated).toBe(1);
    expect(rig.client.ready).toBe(false);
  });

  it('dispose khi init chưa xong → init bị từ chối MODEL_INIT_FAILED và bộ đếm 30 giây bị hủy (không giết worker của lần init sau)', async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    const first = rig.client.init();
    rig.client.dispose();
    await expectCode(first, 'MODEL_INIT_FAILED');
    vi.advanceTimersByTime(20_000);
    void rig.client.init().catch(() => undefined); // worker mới, bộ đếm mới
    vi.advanceTimersByTime(15_000); // đã 35 giây kể từ lần init đầu, mới 15 giây kể từ lần init hai
    expect(rig.workers).toHaveLength(2);
    expect(rig.worker().terminated).toBe(0);
  });

  it('gọi dispose lặp lại hoặc khi chưa có worker đều an toàn', async () => {
    const fresh = makeRig();
    expect(() => fresh.client.dispose()).not.toThrow();
    const rig = await makeReadyRig();
    rig.client.dispose();
    rig.client.dispose();
    expect(rig.worker().terminated).toBe(1);
  });

  it('phản hồi đến sau dispose bị bỏ qua', async () => {
    const rig = await makeReadyRig();
    const worker = rig.worker();
    const pending = rig.client.infer(makeFrame(1).frame);
    rig.client.dispose();
    await pending;
    expect(() => worker.emit(resultFor(1))).not.toThrow();
  });

  it('init lại sau dispose tạo worker mới', async () => {
    const rig = await makeReadyRig();
    rig.client.dispose();
    const again = rig.client.init();
    expect(rig.workers).toHaveLength(2);
    rig.worker().emit({ type: 'READY', info: INFO });
    await expect(again).resolves.toBe(INFO);
  });
});