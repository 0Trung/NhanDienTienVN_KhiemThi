import { AppError } from '../contracts';
import type { Detection, FrameMeta, IPostProcessor, IPreprocessor, PreprocessResult, WorkerRequest, WorkerResponse } from '../contracts';
import { center } from '../utils/geometry';
import { createLogger } from '../utils/logger';
import { systemClock } from '../utils/time';
import type { Clock } from '../utils/time';
import type { ModelRunner } from './model-manager';

const log = createLogger('worker-core');

export interface WorkerCoreOptions {
  model: ModelRunner;
  preprocessor: IPreprocessor;
  postProcessor: IPostProcessor;
  now?: Clock;
}

export interface WorkerCore {
  /** Trả đúng một phản hồi cho INIT/INFER; DISPOSE không có phản hồi (null). */
  handle(request: WorkerRequest): Promise<WorkerResponse | null>;
}

/** Đóng bitmap; lỗi khi đóng chỉ được ghi log, không làm hỏng luồng xử lý. */
export function closeBitmap(bitmap: ImageBitmap): void {
  try {
    bitmap.close();
  } catch (e) {
    log.warn('Không đóng được bitmap', e);
  }
}

/** Trái → phải theo tâm x, hòa thì theo y: bảo đảm hợp đồng InferenceResult dù hậu xử lý đã sắp hay chưa. */
function leftToRight(a: Detection, b: Detection): number {
  const ca = center(a.bbox);
  const cb = center(b.bbox);
  return ca.x - cb.x || ca.y - cb.y;
}

/**
 * Lõi xử lý của worker (F5): nhận WorkerRequest, trả WorkerResponse. Chỉ xử lý một khung một lúc:
 * khung đến khi đang bận bị DROPPED. Bitmap được đóng ở mọi nhánh (đóng ngay sau tiền xử lý để giải phóng bộ nhớ sớm).
 */
export function createWorkerCore(o: WorkerCoreOptions): WorkerCore {
  const now = o.now ?? systemClock;
  let busy = false;
  let disposed = false;

  async function infer(meta: FrameMeta, bitmap: ImageBitmap): Promise<WorkerResponse> {
    if (busy || disposed) {
      closeBitmap(bitmap);
      return { type: 'DROPPED', frameId: meta.frameId };
    }
    busy = true; // đặt đồng bộ, trước mọi await, để khung đến sau thấy ngay
    try {
      const t0 = now();
      let pre: PreprocessResult;
      try {
        pre = o.preprocessor.process(bitmap);
      } finally {
        closeBitmap(bitmap);
      }
      const t1 = now();
      const raw = await o.model.predict(pre.tensor);
      const t2 = now();
      const detections = o.postProcessor.process(raw, pre.letterbox, meta).slice().sort(leftToRight);
      const t3 = now();
      const timings = { preprocessMs: t1 - t0, inferMs: t2 - t1, postprocessMs: t3 - t2, totalMs: t3 - t0 };
      return { type: 'RESULT', result: { meta, detections, gray: pre.gray, timings } };
    } catch (e) {
      log.warn(`Khung ${meta.frameId} lỗi`, e);
      return {
        type: 'ERROR',
        code: e instanceof AppError ? e.code : 'INFERENCE_FAILED',
        message: `Không xử lý được khung hình ${meta.frameId}: ${e instanceof Error ? e.message : String(e)}`,
        fatal: false,
        frameId: meta.frameId,
      };
    } finally {
      busy = false;
    }
  }

  return {
    async handle(request) {
      switch (request.type) {
        case 'INFER':
          return infer(request.meta, request.bitmap);
        case 'INIT': // mô hình đã nạp sẵn khi tạo core: báo lại thông tin
          return { type: 'READY', info: o.model.info };
        case 'DISPOSE':
          if (disposed) return null; // gọi lặp: mô hình đã được giải phóng, không giải phóng lần hai
          disposed = true;
          try {
            await o.model.dispose();
          } catch (e) {
            log.warn('Giải phóng mô hình lỗi', e);
          }
          return null;
      }
    },
  };
}
