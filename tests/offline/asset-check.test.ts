import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/contracts';
import { checkBundledAssets } from '../../src/offline/asset-check';
import { setLogSink } from '../../src/utils/logger';

const BASE = 'https://app.local/';
const ONNX_BYTES = 64;
const WASM = 'ort/ort-wasm-simd-threaded.wasm';
const CLASSES = { '0': 20000, '1': 500000, '2': 1000, '3': 100000, '4': 5000, '5': 50000, '6': 2000, '7': 200000, '8': 10000 };

/** Gói giả: đường dẫn tương đối → nội dung chữ, hoặc số byte (file nhị phân giả). */
type Bundle = Record<string, string | number>;

const fullBundle = (): Bundle => ({
  'models/model-manifest.json': JSON.stringify({ file: 'best.onnx', sizeBytes: ONNX_BYTES }),
  'models/classes.json': JSON.stringify(CLASSES),
  'models/model-config.json': JSON.stringify({ inputSize: 640 }),
  'models/best.onnx': ONNX_BYTES,
  'ort/ort-files.json': JSON.stringify({ files: ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'] }),
  [WASM]: 8,
  'ort/ort-wasm-simd-threaded.mjs': 'export {};',
  'audio/manifest.json': JSON.stringify({ clips: { welcome: 'welcome.mp3', noMoney: 'no-money.mp3' } }),
  'audio/welcome.mp3': 4,
  'audio/no-money.mp3': 4,
});
const without = (...paths: string[]): Bundle => {
  const bundle = fullBundle();
  for (const p of paths) delete bundle[p];
  return bundle;
};
const patched = (patch: Bundle): Bundle => ({ ...fullBundle(), ...patch });

/** fetch giả theo gói; ghi lại "PHƯƠNG_THỨC địa_chỉ" của mọi yêu cầu. */
function fakeFetch(bundle: Bundle, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const body = bundle[url.slice(BASE.length)];
    if (body === undefined) return new Response('không có', { status: 404 });
    return new Response(typeof body === 'number' ? new Uint8Array(body) : body);
  }) as typeof fetch;
}
const run = (bundle: Bundle) => checkBundledAssets({ baseUrl: BASE, fetchFn: fakeFetch(bundle) });

describe('checkBundledAssets', () => {
  beforeEach(() => setLogSink(() => undefined));
  afterEach(() => setLogSink(null));

  it('đủ hết thì ok, không thiếu, không cảnh báo', async () => {
    expect(await run(fullBundle())).toEqual({ ok: true, missing: [], warnings: [] });
  });

  it.each([
    { name: 'thiếu file onnx', bundle: without('models/best.onnx'), expected: ['models/best.onnx'] },
    {
      name: 'onnx sai kích thước',
      bundle: patched({ 'models/best.onnx': ONNX_BYTES - 1 }),
      expected: [expect.stringContaining('models/best.onnx (sai kích thước: 63 thay vì 64 byte)')],
    },
    { name: 'thiếu model-manifest.json', bundle: without('models/model-manifest.json'), expected: ['models/model-manifest.json'] },
    {
      name: 'manifest không phải JSON',
      bundle: patched({ 'models/model-manifest.json': '<html>' }),
      expected: ['models/model-manifest.json (không hợp lệ)'],
    },
    {
      name: 'manifest.file trỏ ra ngoài thư mục models',
      bundle: patched({ 'models/model-manifest.json': JSON.stringify({ file: '../x.onnx', sizeBytes: 1 }) }),
      expected: ['models/model-manifest.json (không hợp lệ)'],
    },
    { name: 'thiếu classes.json', bundle: without('models/classes.json'), expected: ['models/classes.json'] },
    {
      name: 'classes.json thiếu lớp',
      bundle: patched({ 'models/classes.json': JSON.stringify({ '0': 20000 }) }),
      expected: ['models/classes.json (không hợp lệ)'],
    },
    { name: 'thiếu model-config.json', bundle: without('models/model-config.json'), expected: ['models/model-config.json'] },
    { name: 'thiếu file wasm', bundle: without(WASM), expected: [WASM] },
    { name: 'file wasm rỗng', bundle: patched({ [WASM]: 0 }), expected: [`${WASM} (rỗng)`] },
  ])('$name → ok=false và error OFFLINE_NOT_READY', async ({ bundle, expected }) => {
    const result = await run(bundle);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expected);
    expect(result.error).toBeInstanceOf(AppError);
    expect(result.error?.code).toBe('OFFLINE_NOT_READY');
    expect(result.error?.message).toBe('Ứng dụng thiếu dữ liệu nhận dạng. Hãy cài lại ứng dụng.');
  });

  it.each([
    { name: 'thiếu một file âm thanh', bundle: without('audio/no-money.mp3'), warning: 'audio/no-money.mp3' },
    { name: 'thiếu audio/manifest.json', bundle: without('audio/manifest.json'), warning: 'audio/manifest.json' },
    { name: 'ort-files.json vắng (wasm chưa kiểm tra được)', bundle: without('ort/ort-files.json', WASM), warning: 'ort/ort-files.json' },
  ])('$name chỉ là cảnh báo', async ({ bundle, warning }) => {
    const result = await run(bundle);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining(warning)]);
  });

  it('danh sách dạng mảng chuỗi (ort-files.json, audio/manifest.json có tiền tố audio/ hoặc ./) vẫn đọc được', async () => {
    const result = await run(
      patched({
        'ort/ort-files.json': JSON.stringify(['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']),
        'audio/manifest.json': JSON.stringify(['audio/welcome.mp3', './no-money.mp3']),
      }),
    );
    expect(result).toEqual({ ok: true, missing: [], warnings: [] });
  });

  it.each([
    { name: 'fetch ném lỗi bất đồng bộ', fetchFn: (async () => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch },
    {
      name: 'fetchFn ném đồng bộ',
      fetchFn: (() => {
        throw new Error('hỏng ngay khi gọi');
      }) as unknown as typeof fetch,
    },
  ])('$name: không ném ra ngoài, ok=false', async ({ fetchFn }) => {
    const result = await checkBundledAssets({ baseUrl: BASE, fetchFn });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('OFFLINE_NOT_READY');
  });

  it('đo được kích thước dù phản hồi không có body stream', async () => {
    const bundle = fullBundle();
    const fetchFn = (async (input: RequestInfo | URL) => {
      const body = bundle[String(input).slice(BASE.length)];
      if (body === undefined) return { ok: false, status: 404 } as Response;
      const size = typeof body === 'number' ? body : body.length;
      return { ok: true, status: 200, text: async () => String(body), arrayBuffer: async () => new ArrayBuffer(size) } as unknown as Response;
    }) as typeof fetch;
    expect(await checkBundledAssets({ baseUrl: BASE, fetchFn })).toEqual({ ok: true, missing: [], warnings: [] });
  });

  it.each([
    { baseUrl: './', expected: 'GET ./models/model-manifest.json' },
    { baseUrl: 'https://x.test/app', expected: 'GET https://x.test/app/models/model-manifest.json' },
    { baseUrl: 'https://x.test/app/', expected: 'GET https://x.test/app/models/model-manifest.json' },
    { baseUrl: '', expected: 'GET models/model-manifest.json' },
  ])('baseUrl "$baseUrl" ghép đúng địa chỉ và chỉ dùng GET', async ({ baseUrl, expected }) => {
    const calls: string[] = [];
    await checkBundledAssets({ baseUrl, fetchFn: fakeFetch({}, calls) });
    expect(calls).toContain(expected);
    expect(calls.some((c) => !c.startsWith('GET'))).toBe(false);
  });
});