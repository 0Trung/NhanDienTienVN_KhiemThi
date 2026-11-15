import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import { AppError } from '../../src/contracts';
import type { AppErrorCode, ModelConfigJson, ModelManifest } from '../../src/contracts';
import { clearRecentLogs, getRecentLogs, setLogLevel, setLogSink } from '../../src/utils/logger';
import { loadModel } from '../../src/vision/model-manager';
import type { FetchLike, LoadModelOptions, OrtModule, RuntimeEnv } from '../../src/vision/model-manager';

const SIZE = 4;
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const MANIFEST: ModelManifest = {
  version: '9.9.9', file: 'm.onnx', sizeBytes: BYTES.length, sha256: sha256(BYTES), ultralytics: 'x', opset: 18,
  classCount: 9, exportedAt: 'x', inputName: 'images', inputShape: [1, 3, SIZE, SIZE], outputName: 'output0', outputShape: [1, 13, 2],
};
const MODEL_CONFIG: ModelConfigJson = {
  inputSize: SIZE, padValue: 114, channelOrder: 'RGB', layout: 'NCHW', normalize: 'div255',
  outputLayout: 'channels_first', confLow: 0.25, confSure: 0.7, nmsIou: 0.7, agnosticNms: false, maxDetections: 20,
};
const CLASSES = { '0': 1000 }; // loadModel không kiểm giá trị lớp: buildClassMap làm việc đó ở file keo
const RUNTIME: RuntimeEnv = {
  crossOriginIsolated: false, hardwareConcurrency: 8, hasWebGpu: false,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
};

type Files = Record<string, unknown>;
const GOOD: Files = { 'model-manifest.json': MANIFEST, 'model-config.json': MODEL_CONFIG, 'classes.json': CLASSES, 'm.onnx': BYTES };

/** fetch giả: tra tệp theo tên cuối URL; không có thì 404. */
function makeFetch(files: Files, urls: string[] = []): FetchLike {
  return async (url) => {
    urls.push(url);
    const body = files[url.slice(url.lastIndexOf('/') + 1)];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    const buffer = body instanceof Uint8Array ? body.slice().buffer : new ArrayBuffer(0);
    return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => buffer };
  };
}

interface FakeOrt {
  ort: OrtModule;
  env: { wasm: Record<string, unknown> };
  created: Array<{ options: unknown }>;
  runs: Array<{ feeds: Record<string, { dims: readonly number[]; data: unknown }>; fetches: readonly string[] }>;
  counters: { tensorsDisposed: number; released: number };
  state: { output: unknown };
}

/** ORT giả: ghi lại cấu hình env, lần tạo session, lần chạy và số tensor/session đã giải phóng. */
function makeOrt(createError?: Error): FakeOrt {
  const env = { wasm: {} as Record<string, unknown> };
  const created: FakeOrt['created'] = [];
  const runs: FakeOrt['runs'] = [];
  const counters = { tensorsDisposed: 0, released: 0 };
  const state = { output: new Float32Array([1, 2, 3]) as unknown };
  class FakeTensor {
    constructor(readonly type: string, readonly data: unknown, readonly dims: readonly number[]) {}
    dispose(): void {
      counters.tensorsDisposed += 1;
    }
  }
  const session = {
    run: async (feeds: Record<string, FakeTensor>, fetches: readonly string[]) => {
      runs.push({ feeds, fetches });
      return { output0: new FakeTensor('float32', state.output, [1, 13, 2]) };
    },
    release: async () => {
      counters.released += 1;
    },
  };
  const ort = {
    env,
    InferenceSession: {
      create: async (_model: Uint8Array, options: unknown) => {
        created.push({ options });
        if (createError) throw createError;
        return session;
      },
    },
    Tensor: FakeTensor,
  } as unknown as OrtModule;
  return { ort, env, created, runs, counters, state };
}

const load = (fake: FakeOrt, over: Partial<LoadModelOptions> = {}) =>
  loadModel({
    baseUrl: 'models', ortBaseUrl: 'ort', config: DEFAULT_CONFIG.inference, fetchFn: makeFetch(GOOD),
    ortLoader: async () => fake.ort, runtime: RUNTIME, ...over,
  });

async function expectCode(promise: Promise<unknown>, code: AppErrorCode): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('loadModel', () => {
  beforeEach(() => {
    setLogLevel('debug');
    setLogSink(() => undefined);
    clearRecentLogs();
  });

  it('đủ tệp hợp lệ thì sẵn sàng, ModelInfo đúng và loadMs/warmupMs đo bằng now', async () => {
    let t = 0;
    const model = await load(makeOrt(), { now: () => (t += 10) });
    expect(model.info).toEqual({ version: '9.9.9', inputSize: SIZE, classCount: 9, backend: 'wasm', threads: 1, loadMs: 10, warmupMs: 10 });
    expect(model.classes).toEqual(CLASSES);
    expect(model.config).toEqual(MODEL_CONFIG);
  });

  it('ghi log phiên bản WebView, crossOriginIsolated, số lõi và WebGPU để chẩn đoán trên máy thật', async () => {
    await load(makeOrt(), { runtime: { ...RUNTIME, crossOriginIsolated: true } });
    const logs = getRecentLogs().join('\n');
    expect(logs).toContain('Android WebView 126.0.0.0');
    expect(logs).toContain('crossOriginIsolated=true');
    expect(logs).toContain('CPU=8');
    expect(logs).toContain('WebGPU=false');
  });

  it('cấu hình ORT: wasmPaths nội bộ có dấu /, simd bật, chỉ wasm, tối ưu all; đọc đúng 4 tệp theo thứ tự', async () => {
    const fake = makeOrt();
    const urls: string[] = [];
    await load(fake, { fetchFn: makeFetch(GOOD, urls) });
    expect(fake.env.wasm.wasmPaths).toBe('ort/');
    expect(fake.env.wasm.simd).toBe(true);
    expect(fake.created.map((c) => c.options)).toEqual([{ executionProviders: ['wasm'], graphOptimizationLevel: 'all' }]);
    expect(urls).toEqual(['models/model-manifest.json', 'models/model-config.json', 'models/classes.json', 'models/m.onnx']);
  });

  it('chạy nóng đúng một lần bằng tensor toàn 0, theo tên input/output của manifest', async () => {
    const fake = makeOrt();
    await load(fake);
    expect(fake.runs).toHaveLength(1);
    const run = fake.runs[0];
    const input = run?.feeds.images;
    expect(run?.fetches).toEqual(['output0']);
    expect(input?.dims).toEqual([1, 3, SIZE, SIZE]);
    expect((input?.data as Float32Array).length).toBe(3 * SIZE * SIZE);
    expect((input?.data as Float32Array).every((v) => v === 0)).toBe(true);
  });

  it.each(['model-manifest.json', 'model-config.json', 'classes.json', 'm.onnx'])('thiếu %s → MODEL_MISSING', async (drop) => {
    const files = { ...GOOD };
    delete files[drop];
    await expectCode(load(makeOrt(), { fetchFn: makeFetch(files) }), 'MODEL_MISSING');
  });

  it('fetch ném lỗi → MODEL_MISSING', async () => {
    const fetchFn: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expectCode(load(makeOrt(), { fetchFn }), 'MODEL_MISSING');
  });

  it.each([
    { name: 'sai kích thước', files: { ...GOOD, 'm.onnx': BYTES.slice(0, 5) } },
    { name: 'sai sha256', files: { ...GOOD, 'model-manifest.json': { ...MANIFEST, sha256: sha256(new Uint8Array([9])) } } },
    { name: 'manifest lệch inputSize của model-config', files: { ...GOOD, 'model-config.json': { ...MODEL_CONFIG, inputSize: SIZE * 2 } } },
    { name: 'manifest thiếu trường bắt buộc', files: { ...GOOD, 'model-manifest.json': { version: '1' } } },
  ])('$name → MODEL_CORRUPT', async ({ files }) => {
    await expectCode(load(makeOrt(), { fetchFn: makeFetch(files) }), 'MODEL_CORRUPT');
  });

  it('JSON hỏng → MODEL_CORRUPT', async () => {
    const base = makeFetch(GOOD);
    const fetchFn: FetchLike = async (url) => ({
      ...(await base(url)),
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    await expectCode(load(makeOrt(), { fetchFn }), 'MODEL_CORRUPT');
  });

  it('verifyChecksum=false bỏ qua sha256 nhưng vẫn kiểm kích thước', async () => {
    const config = { ...DEFAULT_CONFIG.inference, verifyChecksum: false };
    const badSha = { ...GOOD, 'model-manifest.json': { ...MANIFEST, sha256: 'sai' } };
    await expect(load(makeOrt(), { config, fetchFn: makeFetch(badSha) })).resolves.toBeDefined();
    const badSize = { ...GOOD, 'm.onnx': BYTES.slice(0, 5) };
    await expectCode(load(makeOrt(), { config, fetchFn: makeFetch(badSize) }), 'MODEL_CORRUPT');
  });

  it('ORT không tạo được session → MODEL_INIT_FAILED (fatal)', async () => {
    const error = await expectCode(load(makeOrt(new Error('boom'))), 'MODEL_INIT_FAILED');
    expect(error.fatal).toBe(true);
  });

  it('không nạp được ORT → MODEL_INIT_FAILED', async () => {
    const ortLoader = async (): Promise<OrtModule> => {
      throw new Error('import lỗi');
    };
    await expectCode(load(makeOrt(), { ortLoader }), 'MODEL_INIT_FAILED');
  });

  it('chạy nóng lỗi → MODEL_INIT_FAILED và session được giải phóng', async () => {
    const fake = makeOrt();
    fake.state.output = [1, 2, 3]; // không phải Float32Array
    await expectCode(load(fake), 'MODEL_INIT_FAILED');
    expect(fake.counters.released).toBe(1);
  });

  it.each([
    { isolated: false, cores: 8, expected: 1 },
    { isolated: true, cores: 8, expected: 4 },
    { isolated: true, cores: 2, expected: 2 },
    { isolated: true, cores: 1, expected: 1 },
    { isolated: true, cores: 0, expected: 1 },
  ])('crossOriginIsolated=$isolated với $cores lõi → $expected luồng', async ({ isolated, cores, expected }) => {
    const fake = makeOrt();
    const runtime = { ...RUNTIME, crossOriginIsolated: isolated, hardwareConcurrency: cores };
    const model = await load(fake, { runtime });
    expect(fake.env.wasm.numThreads).toBe(expected);
    expect(model.info.threads).toBe(expected);
  });

  describe('WebGPU', () => {
    const gpuConfig = { ...DEFAULT_CONFIG.inference, preferWebGpu: true };
    const gpuRuntime = { ...RUNTIME, hasWebGpu: true };

    it('ưu tiên và có navigator.gpu → thử webgpu trước và ghi backend webgpu', async () => {
      const gpu = makeOrt();
      const ortLoader = vi.fn(async () => gpu.ort);
      const model = await load(gpu, { config: gpuConfig, runtime: gpuRuntime, ortLoader });
      expect(ortLoader.mock.calls).toEqual([['webgpu']]);
      expect(gpu.created.map((c) => c.options)).toEqual([{ executionProviders: ['webgpu'], graphOptimizationLevel: 'all' }]);
      expect(model.info.backend).toBe('webgpu');
    });

    it('webgpu lỗi → rơi về wasm và ghi backend thật là wasm', async () => {
      const gpu = makeOrt(new Error('không có adapter'));
      const wasm = makeOrt();
      const ortLoader = vi.fn(async (backend: string) => (backend === 'webgpu' ? gpu.ort : wasm.ort));
      const model = await load(wasm, { config: gpuConfig, runtime: gpuRuntime, ortLoader });
      expect(ortLoader.mock.calls).toEqual([['webgpu'], ['wasm']]);
      expect(model.info.backend).toBe('wasm');
    });

    it('ưu tiên nhưng không có navigator.gpu → chỉ dùng wasm', async () => {
      const wasm = makeOrt();
      const ortLoader = vi.fn(async () => wasm.ort);
      await load(wasm, { config: gpuConfig, ortLoader });
      expect(ortLoader.mock.calls).toEqual([['wasm']]);
    });
  });

  describe('predict và dispose', () => {
    it('trả RawModelOutput (data, dims) và giải phóng tensor vào lẫn ra', async () => {
      const fake = makeOrt();
      const model = await load(fake);
      fake.counters.tensorsDisposed = 0; // bỏ phần của lần chạy nóng
      const raw = await model.predict(new Float32Array(3 * SIZE * SIZE));
      expect(raw.dims).toEqual([1, 13, 2]);
      expect(Array.from(raw.data)).toEqual([1, 2, 3]);
      expect(fake.counters.tensorsDisposed).toBe(2);
    });

    it('tensor sai kích thước → INFERENCE_FAILED, không chạm session', async () => {
      const fake = makeOrt();
      const model = await load(fake);
      await expectCode(model.predict(new Float32Array(5)), 'INFERENCE_FAILED');
      expect(fake.runs).toHaveLength(1); // chỉ có lần chạy nóng
    });

    it('đầu ra không phải float32 → INFERENCE_FAILED nhưng vẫn giải phóng tensor', async () => {
      const fake = makeOrt();
      const model = await load(fake);
      fake.counters.tensorsDisposed = 0;
      fake.state.output = new Uint8Array(3);
      await expectCode(model.predict(new Float32Array(3 * SIZE * SIZE)), 'INFERENCE_FAILED');
      expect(fake.counters.tensorsDisposed).toBe(2);
    });

    it('dispose giải phóng session', async () => {
      const fake = makeOrt();
      const model = await load(fake);
      await model.dispose();
      expect(fake.counters.released).toBe(1);
    });
  });
});
