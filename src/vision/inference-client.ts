import { AppError } from '../contracts';
import type { AppConfig, CapturedFrame, IInferenceClient, InferenceResult, ModelInfo, WorkerRequest, WorkerResponse } from '../contracts';
import { createLogger } from '../utils/logger';

const log = createLogger('inference-client');

/** Quá hạn này mà worker chưa báo READY thì khởi tạo bị coi là thất bại (đề bài P05: 30 giây). */
const INIT_TIMEOUT_MS = 30_000;

export interface InferenceClientOptions {
  modelBaseUrl: string;
  ortBaseUrl: string;
  config: AppConfig['inference'];
  workerFactory?: () => Worker;
}

interface Slot<T> { resolve(value: T): void; reject(error: AppError): void }
interface InferSlot extends Slot<InferenceResult | null> { frameId: number }

/**
 * Worker hiểu URL tương đối theo vị trí file worker (bản build nằm trong assets/), không theo trang.
 * Nên đổi sang URL tuyệt đối cùng nguồn (vẫn là file trong APK) ngay ở main thread, và luôn kết thúc bằng '/'.
 */
function toAbsoluteDir(path: string): string {
  let url = path;
  if (typeof document !== 'undefined') {
    try {
      url = new URL(path, document.baseURI).href;
    } catch {
      // giữ nguyên chuỗi gốc
    }
  }
  return url.endsWith('/') ? url : `${url}/`;
}

function closeBitmap(bitmap: ImageBitmap): void {
  try {
    bitmap.close();
  } catch (e) {
    log.warn('Không đóng được bitmap', e);
  }
}

/** Client mỏng trên main thread (F7): mọi việc nặng chạy trong inference-worker. Chỉ một yêu cầu infer bay cùng lúc. */
export function createInferenceClient(o: InferenceClientOptions): IInferenceClient {
  const makeWorker = o.workerFactory ?? (() => new Worker(new URL('./inference-worker.ts', import.meta.url), { type: 'module' }));
  let worker: Worker | null = null;
  let isReady = false;
  let initPromise: Promise<ModelInfo> | null = null;
  let initSlot: Slot<ModelInfo> | null = null;
  let inferSlot: InferSlot | null = null;

  /** Dừng worker và xử lý mọi lời hứa đang chờ: có reason thì reject, không có (dispose) thì infer trả null. */
  function teardown(reason: AppError | null): void {
    const w = worker;
    const init = initSlot;
    const run = inferSlot;
    worker = null;
    isReady = false;
    initPromise = null;
    initSlot = null;
    inferSlot = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      w.terminate();
    }
    init?.reject(reason ?? new AppError('MODEL_INIT_FAILED', 'Bộ suy luận bị hủy khi đang khởi tạo.', true));
    if (run) {
      if (reason) run.reject(reason);
      else run.resolve(null);
    }
  }

  function settle(frameId: number, done: (slot: InferSlot) => void): void {
    const slot = inferSlot;
    if (!slot || slot.frameId !== frameId) {
      log.warn(`Bỏ qua phản hồi lạc của khung ${frameId}`);
      return;
    }
    inferSlot = null;
    done(slot);
  }

  function onMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'READY': {
        const slot = initSlot;
        initSlot = null;
        if (slot) {
          isReady = true;
          slot.resolve(msg.info);
        }
        break;
      }
      case 'RESULT':
        settle(msg.result.meta.frameId, (s) => s.resolve(msg.result));
        break;
      case 'DROPPED':
        settle(msg.frameId, (s) => s.resolve(null));
        break;
      case 'ERROR': {
        const error = new AppError(msg.code, msg.message, msg.fatal);
        if (initSlot || msg.fatal) teardown(error);
        else if (msg.frameId === undefined) log.warn('Worker báo lỗi không kèm khung', msg.message);
        else settle(msg.frameId, (s) => s.reject(error));
        break;
      }
    }
  }

  function crash(what: string): void {
    log.error('Worker suy luận chết bất ngờ', what);
    const code = initSlot ? 'MODEL_INIT_FAILED' : 'INFERENCE_FAILED'; // chết lúc khởi tạo = khởi tạo thất bại
    teardown(new AppError(code, `Worker suy luận dừng bất ngờ: ${what}`, true));
  }

  function init(): Promise<ModelInfo> {
    if (initPromise) return initPromise;
    initPromise = new Promise<ModelInfo>((resolve, reject) => {
      const timer = setTimeout(
        () => teardown(new AppError('MODEL_INIT_FAILED', `Khởi tạo mô hình quá ${INIT_TIMEOUT_MS / 1000} giây.`, true)),
        INIT_TIMEOUT_MS,
      );
      initSlot = {
        resolve: (info) => {
          clearTimeout(timer);
          resolve(info);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      try {
        const w = makeWorker();
        worker = w;
        w.onmessage = (ev: MessageEvent<WorkerResponse>) => onMessage(ev.data);
        w.onerror = (ev: ErrorEvent) => crash(ev.message || 'lỗi không rõ');
        w.onmessageerror = () => crash('không đọc được thông điệp');
        const request: WorkerRequest = {
          type: 'INIT',
          modelBaseUrl: toAbsoluteDir(o.modelBaseUrl),
          ortBaseUrl: toAbsoluteDir(o.ortBaseUrl),
          config: o.config,
        };
        w.postMessage(request);
      } catch (e) {
        teardown(new AppError('MODEL_INIT_FAILED', 'Không tạo được Web Worker suy luận.', true, e));
      }
    });
    return initPromise;
  }

  function infer(frame: CapturedFrame): Promise<InferenceResult | null> {
    const w = worker;
    if (!isReady || !w) {
      closeBitmap(frame.bitmap);
      return Promise.reject(new AppError('INFERENCE_FAILED', 'Bộ suy luận chưa sẵn sàng: cần gọi init() trước.'));
    }
    if (inferSlot) {
      closeBitmap(frame.bitmap); // đang xử lý một khung: bỏ khung này
      return Promise.resolve(null);
    }
    return new Promise<InferenceResult | null>((resolve, reject) => {
      inferSlot = { frameId: frame.meta.frameId, resolve, reject };
      const request: WorkerRequest = { type: 'INFER', meta: frame.meta, bitmap: frame.bitmap };
      try {
        w.postMessage(request, [frame.bitmap]); // chuyển quyền sở hữu bitmap sang worker; worker chịu trách nhiệm đóng
      } catch (e) {
        inferSlot = null;
        closeBitmap(frame.bitmap);
        reject(new AppError('INFERENCE_FAILED', 'Không gửi được khung hình sang worker.', false, e));
      }
    });
  }

  return {
    get ready() {
      return isReady;
    },
    init,
    infer,
    dispose: () => teardown(null),
  };
}