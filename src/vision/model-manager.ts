import { AppError } from '../contracts';
import type { AppConfig, ClassesJson, ModelConfigJson, ModelInfo, ModelManifest, RawModelOutput } from '../contracts';
import { createLogger } from '../utils/logger';
import { systemClock } from '../utils/time';
import type { Clock } from '../utils/time';
import type { InferenceSession } from 'onnxruntime-web/wasm';

/**
 * Nạp và chạy mô hình ONNX bằng onnxruntime-web. Thuần logic, không phụ thuộc trình duyệt nên chạy được
 * trong Worker lẫn Node; fetch, ORT và thông tin môi trường đều nhận qua tham số để test bằng đồ giả.
 */
const log = createLogger('model-manager');

/** Số luồng WASM tối đa khi trang được cô lập đa nguồn gốc (crossOriginIsolated). */
const MAX_WASM_THREADS = 4;

type Backend = ModelInfo['backend'];

/** Phần của onnxruntime-web mà module này dùng; đồ giả trong test chỉ cần thỏa cấu trúc này. */
export type OrtModule = Pick<typeof import('onnxruntime-web/wasm'), 'env' | 'InferenceSession' | 'Tensor'>;
/** Phần của Response mà module cần; fetch thật thỏa cấu trúc này. */
export interface FetchResponseLike { ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }
export type FetchLike = (url: string) => Promise<FetchResponseLike>;
/** Thông tin môi trường chạy, đọc từ globalThis (test tiêm giá trị giả). */
export interface RuntimeEnv { crossOriginIsolated: boolean; hardwareConcurrency: number; hasWebGpu: boolean; userAgent: string }

export interface LoadModelOptions {
  baseUrl: string;
  ortBaseUrl: string;
  config: AppConfig['inference'];
  fetchFn?: FetchLike;
  /** Nạp ORT theo backend; mặc định import động onnxruntime-web/wasm hoặc onnxruntime-web/webgpu. */
  ortLoader?: (backend: Backend) => Promise<OrtModule>;
  runtime?: RuntimeEnv;
  now?: Clock;
}

/** Phần worker-core cần của một mô hình đã nạp. */
export interface ModelRunner {
  readonly info: ModelInfo;
  predict(tensor: Float32Array): Promise<RawModelOutput>;
  dispose(): Promise<void>;
}
export interface LoadedModel extends ModelRunner {
  readonly manifest: ModelManifest;
  readonly config: ModelConfigJson;
  /** Nguyên văn classes.json; giá trị được kiểm bằng buildClassMap ở nơi dùng. */
  readonly classes: ClassesJson;
}

const withSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`);
const fileName = (url: string): string => url.slice(url.lastIndexOf('/') + 1);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isClasses = (v: unknown): v is ClassesJson => isRecord(v);
const isModelConfig = (v: unknown): v is ModelConfigJson => isRecord(v) && Number.isInteger(v.inputSize) && Number(v.inputSize) > 0;
const isManifest = (v: unknown): v is ModelManifest =>
  isRecord(v) && typeof v.file === 'string' && typeof v.sha256 === 'string' && typeof v.version === 'string' &&
  typeof v.inputName === 'string' && typeof v.outputName === 'string' && Array.isArray(v.inputShape) &&
  Number.isInteger(v.sizeBytes) && Number.isInteger(v.classCount);

function readRuntimeEnv(): RuntimeEnv {
  const g = globalThis as { crossOriginIsolated?: boolean; navigator?: { hardwareConcurrency?: number; userAgent?: string; gpu?: unknown } };
  return {
    crossOriginIsolated: g.crossOriginIsolated === true,
    hardwareConcurrency: g.navigator?.hardwareConcurrency ?? 1,
    hasWebGpu: g.navigator?.gpu !== undefined,
    userAgent: g.navigator?.userAgent ?? '',
  };
}

function describeRuntime(r: RuntimeEnv): string {
  const chrome = /Chrome\/([\d.]+)/.exec(r.userAgent)?.[1] ?? 'không rõ';
  const kind = /;\s*wv\)/.test(r.userAgent) ? 'Android WebView' : 'Chrome';
  return `Môi trường: ${kind} ${chrome}; crossOriginIsolated=${r.crossOriginIsolated}; CPU=${r.hardwareConcurrency}; WebGPU=${r.hasWebGpu}`;
}

/** WebView thường không cô lập đa nguồn gốc nên chỉ dùng đa luồng khi crossOriginIsolated. */
function pickThreads(r: RuntimeEnv): number {
  if (!r.crossOriginIsolated) return 1;
  return Math.max(1, Math.min(MAX_WASM_THREADS, Math.floor(r.hardwareConcurrency) || 1));
}

/** Bản wasm-only dùng ort-wasm-simd-threaded.{mjs,wasm}: đúng các file scripts/copy-ort-wasm.mjs chép vào public/ort. */
function importOrt(backend: Backend): Promise<OrtModule> {
  return backend === 'webgpu' ? import('onnxruntime-web/webgpu') : import('onnxruntime-web/wasm');
}

async function fetchOk(fetchFn: FetchLike, url: string): Promise<FetchResponseLike> {
  let res: FetchResponseLike;
  try {
    res = await fetchFn(url);
  } catch (e) {
    throw new AppError('MODEL_MISSING', `Không đọc được tệp mô hình "${fileName(url)}".`, true, e);
  }
  if (!res.ok) throw new AppError('MODEL_MISSING', `Không tìm thấy tệp mô hình "${fileName(url)}" (HTTP ${res.status}).`, true);
  return res;
}

async function fetchJson<T>(fetchFn: FetchLike, url: string, guard: (v: unknown) => v is T): Promise<T> {
  const res = await fetchOk(fetchFn, url);
  let value: unknown;
  try {
    value = await res.json();
  } catch (e) {
    throw new AppError('MODEL_CORRUPT', `Tệp "${fileName(url)}" không phải JSON hợp lệ.`, true, e);
  }
  if (!guard(value)) throw new AppError('MODEL_CORRUPT', `Tệp "${fileName(url)}" thiếu hoặc sai trường bắt buộc.`, true);
  return value;
}

async function fetchBytes(fetchFn: FetchLike, url: string): Promise<ArrayBuffer> {
  const res = await fetchOk(fetchFn, url);
  try {
    return await res.arrayBuffer();
  } catch (e) {
    throw new AppError('MODEL_MISSING', `Đọc dở tệp mô hình "${fileName(url)}".`, true, e);
  }
}

async function verifyBytes(buffer: ArrayBuffer, manifest: ModelManifest, checksum: boolean): Promise<void> {
  if (buffer.byteLength !== manifest.sizeBytes) {
    throw new AppError('MODEL_CORRUPT', `Tệp mô hình sai kích thước: nhận ${buffer.byteLength} byte, manifest ghi ${manifest.sizeBytes}.`, true);
  }
  if (!checksum) return;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new AppError('UNSUPPORTED_BROWSER', 'Thiếu crypto.subtle (cần HTTPS hoặc localhost) nên không kiểm tra được sha256; đặt verifyChecksum=false khi chạy thử qua http.', true);
  }
  const bytes = new Uint8Array(await subtle.digest('SHA-256', buffer));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== manifest.sha256.toLowerCase()) {
    throw new AppError('MODEL_CORRUPT', `Tệp mô hình sai sha256: nhận ${hex.slice(0, 12)}…, manifest ghi ${manifest.sha256.slice(0, 12)}….`, true);
  }
}

/** F4: tạo ort.Tensor [1,3,S,S], chạy session, trả RawModelOutput; luôn giải phóng tensor tạm. */
function makePredict(ort: OrtModule, session: InferenceSession, manifest: ModelManifest, size: number) {
  const dims = [1, 3, size, size];
  const expected = 3 * size * size;
  return async (tensor: Float32Array): Promise<RawModelOutput> => {
    if (tensor.length !== expected) {
      throw new AppError('INFERENCE_FAILED', `Tensor đầu vào có ${tensor.length} phần tử, cần ${expected} (1×3×${size}×${size}).`);
    }
    const input = new ort.Tensor('float32', tensor, dims);
    let outputs: InferenceSession.ReturnType | undefined;
    try {
      outputs = await session.run({ [manifest.inputName]: input }, [manifest.outputName]);
      const out = outputs[manifest.outputName];
      if (!out || !(out.data instanceof Float32Array)) {
        throw new AppError('INFERENCE_FAILED', `Đầu ra "${manifest.outputName}" thiếu hoặc không phải float32.`);
      }
      return { data: out.data, dims: [...out.dims] };
    } finally {
      input.dispose();
      if (outputs) for (const t of Object.values(outputs)) t.dispose();
    }
  };
}

/**
 * F1-F3: đọc manifest/config/classes, tải onnx, kiểm kích thước và sha256, khởi tạo ORT (WASM, hoặc thử WebGPU trước
 * nếu config.preferWebGpu và có navigator.gpu), chạy nóng một lần. Lỗi: MODEL_MISSING, MODEL_CORRUPT, MODEL_INIT_FAILED.
 */
export async function loadModel(o: LoadModelOptions): Promise<LoadedModel> {
  const now = o.now ?? systemClock;
  const fetchFn = o.fetchFn ?? ((url: string) => fetch(url));
  const runtime = o.runtime ?? readRuntimeEnv();
  const t0 = now();
  log.info(describeRuntime(runtime));

  const base = withSlash(o.baseUrl);
  const manifest = await fetchJson(fetchFn, `${base}model-manifest.json`, isManifest);
  const modelConfig = await fetchJson(fetchFn, `${base}model-config.json`, isModelConfig);
  const classes = await fetchJson(fetchFn, `${base}classes.json`, isClasses);
  const size = modelConfig.inputSize;
  const shape = manifest.inputShape;
  if (shape.length !== 4 || shape[2] !== size || shape[3] !== size) {
    throw new AppError('MODEL_CORRUPT', `model-manifest.json (inputShape ${shape.join('×')}) không khớp model-config.json (inputSize ${size}).`, true);
  }
  const buffer = await fetchBytes(fetchFn, `${base}${manifest.file}`);
  await verifyBytes(buffer, manifest, o.config.verifyChecksum);

  const threads = pickThreads(runtime);
  const backends: Backend[] = o.config.preferWebGpu && runtime.hasWebGpu ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError: unknown;
  for (const backend of backends) {
    let session: InferenceSession | undefined;
    try {
      const ort = await (o.ortLoader ?? importOrt)(backend);
      ort.env.wasm.wasmPaths = withSlash(o.ortBaseUrl);
      ort.env.wasm.numThreads = threads;
      ort.env.wasm.simd = true;
      session = await ort.InferenceSession.create(new Uint8Array(buffer), { executionProviders: [backend], graphOptimizationLevel: 'all' });
      const tLoaded = now();
      const predict = makePredict(ort, session, manifest, size);
      await predict(new Float32Array(3 * size * size)); // F3: chạy nóng với tensor toàn 0
      const tWarm = now();
      const live = session;
      const info: ModelInfo = {
        version: manifest.version, inputSize: size, classCount: manifest.classCount,
        backend, threads, loadMs: tLoaded - t0, warmupMs: tWarm - tLoaded,
      };
      log.info('Mô hình sẵn sàng', info);
      return {
        info, manifest, config: modelConfig, classes, predict,
        dispose: async () => {
          try {
            await live.release();
          } catch (e) {
            log.warn('Giải phóng phiên ORT lỗi', e);
          }
        },
      };
    } catch (e) {
      lastError = e;
      log.warn(`Backend ${backend} không dùng được`, e);
      await session?.release().catch(() => undefined);
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new AppError('MODEL_INIT_FAILED', `Không khởi tạo được ONNX Runtime: ${reason}`, true, lastError);
}
