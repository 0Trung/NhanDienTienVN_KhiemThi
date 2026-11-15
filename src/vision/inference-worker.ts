import { DEFAULT_CONFIG } from '../config/app-config';
import { buildClassMap } from '../config/denominations';
import { AppError } from '../contracts';
import type { WorkerRequest, WorkerResponse } from '../contracts';
import { createLogger, setLogLevel } from '../utils/logger';
import { createPreprocessor } from './image-processor';
import { loadModel } from './model-manager';
import type { LoadedModel } from './model-manager';
import { createPostProcessor } from './post-processor';
import { closeBitmap, createWorkerCore } from './worker-core';
import type { WorkerCore } from './worker-core';

/**
 * File keo chạy TRONG Web Worker (F6): nhận WorkerRequest, trả WorkerResponse.
 * Worker có bản logger riêng, mặc định production chỉ ghi warn nên sẽ giấu dòng chẩn đoán lúc khởi tạo
 * (phiên bản WebView, crossOriginIsolated, backend...). Nâng lên info; log từng khung vẫn ở mức debug.
 */
setLogLevel(import.meta.env.DEV ? 'debug' : 'info');
const log = createLogger('inference-worker');

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let core: WorkerCore | null = null;
let initPromise: Promise<WorkerResponse> | null = null;

async function init(req: Extract<WorkerRequest, { type: 'INIT' }>): Promise<WorkerResponse> {
  let model: LoadedModel | undefined;
  try {
    model = await loadModel({ baseUrl: req.modelBaseUrl, ortBaseUrl: req.ortBaseUrl, config: req.config });
    const classMap = buildClassMap(model.classes);
    // INIT không mang AppConfig['analyzer'] nên bề rộng ảnh xám lấy từ DEFAULT_CONFIG (xem "Đề xuất sửa hợp đồng").
    const preprocessor = createPreprocessor({
      inputSize: model.config.inputSize,
      padValue: model.config.padValue,
      grayThumbWidth: DEFAULT_CONFIG.analyzer.grayThumbWidth,
    });
    const postProcessor = createPostProcessor({ classMap, inference: req.config, layoutHint: model.config.outputLayout });
    core = createWorkerCore({ model, preprocessor, postProcessor });
    return { type: 'READY', info: model.info };
  } catch (e) {
    await model?.dispose().catch(() => undefined);
    initPromise = null; // cho phép INIT lại
    log.error('INIT thất bại', e);
    return {
      type: 'ERROR',
      code: e instanceof AppError ? e.code : 'MODEL_INIT_FAILED',
      message: e instanceof Error ? e.message : String(e),
      fatal: true,
    };
  }
}

async function dispatch(req: WorkerRequest): Promise<WorkerResponse | null> {
  if (req.type === 'INIT') {
    initPromise ??= init(req);
    return initPromise;
  }
  if (core) return core.handle(req);
  if (req.type === 'INFER') {
    closeBitmap(req.bitmap);
    return { type: 'ERROR', code: 'INFERENCE_FAILED', message: 'Worker chưa nạp xong mô hình.', fatal: false, frameId: req.meta.frameId };
  }
  return null;
}

scope.onmessage = (event) => {
  dispatch(event.data)
    .then((response) => {
      if (response) scope.postMessage(response);
    })
    .catch((e: unknown) => log.error('Xử lý yêu cầu lỗi', e));
};