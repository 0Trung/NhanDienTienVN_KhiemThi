import { buildClassMap } from '../config/denominations';
import { AppError } from '../contracts';
import type { ClassesJson } from '../contracts';
import { createLogger } from '../utils/logger';

const log = createLogger('asset-check');

export interface AssetCheckOptions {
  /** Thư mục gốc của gói web (chứa models/, ort/, audio/), ví dụ './' hoặc import.meta.env.BASE_URL. */
  baseUrl: string;
  fetchFn?: typeof fetch;
}

export interface AssetCheckResult {
  ok: boolean;
  /** Thành phần BẮT BUỘC bị thiếu hoặc hỏng, kèm lý do nếu có. */
  missing: string[];
  /** Vấn đề không chặn app chạy (thiếu âm thanh, chưa kiểm tra được wasm...). */
  warnings: string[];
  error?: AppError;
}

/** Thông điệp đọc cho người dùng khi gói thiếu dữ liệu. */
const NOT_READY_MESSAGE = 'Ứng dụng thiếu dữ liệu nhận dạng. Hãy cài lại ứng dụng.';

const MANIFEST = 'models/model-manifest.json';
const CLASSES = 'models/classes.json';
const MODEL_CONFIG = 'models/model-config.json';
const ORT_LIST = 'ort/ort-files.json';
const AUDIO_LIST = 'audio/manifest.json';
const AUDIO_FILE = /\.(mp3|ogg|wav|m4a|aac|opus)$/i;
/** Tên file an toàn: không bắt đầu bằng / hoặc ., không chứa .. hay giao thức. */
const SAFE_NAME = /^(?!.*\.\.)\w[\w.\-/]*$/;
const MAX_JSON_DEPTH = 4;

interface Ctx {
  baseUrl: string;
  fetchFn: typeof fetch;
}
interface Findings {
  missing: string[];
  warnings: string[];
}
type Fetched = { status: 'ok'; value: unknown } | { status: 'absent' } | { status: 'invalid' };
type Presence = 'ok' | 'absent' | 'empty';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function joinUrl(base: string, path: string): string {
  if (base === '') return path;
  return base.endsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

function flag(path: string, state: 'absent' | 'invalid' | 'empty'): string {
  const note = state === 'invalid' ? ' (không hợp lệ)' : state === 'empty' ? ' (rỗng)' : '';
  return `${path}${note}`;
}

/** GET một tài nguyên trong gói. Không dùng HEAD vì WebView không đảm bảo hỗ trợ. null khi vắng hoặc lỗi. */
async function getResponse(ctx: Ctx, path: string): Promise<Response | null> {
  try {
    const res = await ctx.fetchFn(joinUrl(ctx.baseUrl, path));
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

const noop = (): void => undefined;

/** Đếm byte của phản hồi mà không giữ dữ liệu lại. full=false: dừng ngay sau khối đầu tiên (chỉ cần biết có dữ liệu). */
async function measure(res: Response, full: boolean): Promise<number> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.arrayBuffer()).byteLength;
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (!full && total > 0) break;
    }
  } finally {
    await reader.cancel().catch(noop);
  }
  return total;
}

async function readJson(ctx: Ctx, path: string): Promise<Fetched> {
  const res = await getResponse(ctx, path);
  if (!res) return { status: 'absent' };
  try {
    return { status: 'ok', value: JSON.parse(await res.text()) as unknown };
  } catch {
    return { status: 'invalid' };
  }
}

/** Kiểm tra file có mặt và không rỗng, không tải hết. */
async function probe(ctx: Ctx, path: string): Promise<Presence> {
  const res = await getResponse(ctx, path);
  if (!res) return 'absent';
  try {
    return (await measure(res, false)) > 0 ? 'ok' : 'empty';
  } catch {
    return 'absent';
  }
}

function parseManifest(v: unknown): { file: string; sizeBytes: number } | null {
  if (!isRecord(v)) return null;
  const { file, sizeBytes } = v;
  if (typeof file !== 'string' || !SAFE_NAME.test(file)) return null;
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return null;
  return { file, sizeBytes };
}

function isValidClasses(v: unknown): boolean {
  try {
    buildClassMap(v as ClassesJson);
    return true;
  } catch {
    return false;
  }
}

/** Danh sách tên file: mảng chuỗi hoặc { files: [...] }. null nếu rỗng hoặc có tên không an toàn. */
function parseNames(v: unknown): string[] | null {
  const list = Array.isArray(v) ? v : isRecord(v) ? v.files : null;
  if (!Array.isArray(list) || list.length === 0) return null;
  const names: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !SAFE_NAME.test(item)) return null;
    names.push(item);
  }
  return [...new Set(names)];
}

/** Định dạng audio/manifest.json chưa có trong hợp đồng nên đọc khoan dung: lấy mọi chuỗi kết thúc bằng đuôi âm thanh. */
function collectAudio(v: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (typeof v === 'string') {
    const name = v.replace(/^(?:\.\/)?(?:audio\/)?/, '');
    if (AUDIO_FILE.test(name) && SAFE_NAME.test(name)) out.add(name);
  } else if (depth < MAX_JSON_DEPTH && typeof v === 'object' && v !== null) {
    for (const child of Object.values(v)) collectAudio(child, out, depth + 1);
  }
  return out;
}

async function checkOnnx(ctx: Ctx, file: string, expected: number): Promise<string | null> {
  const path = `models/${file}`;
  const res = await getResponse(ctx, path);
  if (!res) return path;
  try {
    const actual = await measure(res, true);
    return actual === expected ? null : `${path} (sai kích thước: ${actual} thay vì ${expected} byte)`;
  } catch {
    return `${path} (không đọc hết được)`;
  }
}

async function checkModel(ctx: Ctx): Promise<Findings> {
  const out: Findings = { missing: [], warnings: [] };
  const [manifest, classes, config] = await Promise.all([
    readJson(ctx, MANIFEST),
    readJson(ctx, CLASSES),
    readJson(ctx, MODEL_CONFIG),
  ]);
  if (classes.status !== 'ok') out.missing.push(flag(CLASSES, classes.status));
  else if (!isValidClasses(classes.value)) out.missing.push(flag(CLASSES, 'invalid'));
  if (config.status !== 'ok') out.missing.push(flag(MODEL_CONFIG, config.status));
  else if (!isRecord(config.value)) out.missing.push(flag(MODEL_CONFIG, 'invalid'));

  if (manifest.status !== 'ok') {
    out.missing.push(flag(MANIFEST, manifest.status));
    return out;
  }
  const parsed = parseManifest(manifest.value);
  if (!parsed) {
    out.missing.push(flag(MANIFEST, 'invalid'));
    return out;
  }
  const problem = await checkOnnx(ctx, parsed.file, parsed.sizeBytes);
  if (problem) out.missing.push(problem);
  return out;
}

async function checkOrt(ctx: Ctx): Promise<Findings> {
  const out: Findings = { missing: [], warnings: [] };
  const list = await readJson(ctx, ORT_LIST);
  const names = list.status === 'ok' ? parseNames(list.value) : null;
  if (!names) {
    out.warnings.push(`${ORT_LIST} không có hoặc không hợp lệ: chưa kiểm tra được các file wasm của ORT.`);
    return out;
  }
  const results = await Promise.all(names.map(async (name) => ({ name, state: await probe(ctx, `ort/${name}`) })));
  for (const { name, state } of results) {
    if (state !== 'ok') out.missing.push(flag(`ort/${name}`, state));
  }
  return out;
}

/** Âm thanh ghi sẵn chỉ là dự phòng của giọng đọc nên thiếu chỉ là cảnh báo. */
async function checkAudio(ctx: Ctx): Promise<Findings> {
  const out: Findings = { missing: [], warnings: [] };
  const list = await readJson(ctx, AUDIO_LIST);
  if (list.status !== 'ok') {
    out.warnings.push(`${AUDIO_LIST} không có hoặc không hợp lệ: chưa kiểm tra được âm thanh ghi sẵn.`);
    return out;
  }
  const names = [...collectAudio(list.value)];
  if (names.length === 0) out.warnings.push(`${AUDIO_LIST} không liệt kê file âm thanh nào.`);
  const results = await Promise.all(names.map(async (name) => ({ name, state: await probe(ctx, `audio/${name}`) })));
  for (const { name, state } of results) {
    if (state !== 'ok') out.warnings.push(`Âm thanh ${flag(`audio/${name}`, state)} bị thiếu.`);
  }
  return out;
}

/**
 * Kiểm tra gói APK có đủ tài nguyên để chạy ngoại tuyến: model-manifest.json, classes.json, model-config.json,
 * file onnx (kích thước khớp sizeBytes), các file ORT liệt kê trong ort/ort-files.json, và âm thanh trong audio/manifest.json.
 * Thiếu thành phần bắt buộc thì ok=false kèm AppError OFFLINE_NOT_READY. Không bao giờ ném lỗi ra ngoài.
 */
export async function checkBundledAssets(o: AssetCheckOptions): Promise<AssetCheckResult> {
  const missing: string[] = [];
  const warnings: string[] = [];
  try {
    const ctx: Ctx = {
      baseUrl: o.baseUrl,
      fetchFn: o.fetchFn ?? ((input, init) => globalThis.fetch(input, init)),
    };
    const [model, ort, audio] = await Promise.all([checkModel(ctx), checkOrt(ctx), checkAudio(ctx)]);
    missing.push(...model.missing, ...ort.missing);
    warnings.push(...model.warnings, ...ort.warnings, ...audio.warnings);
  } catch (e) {
    log.error('Kiểm tra gói tài nguyên gặp lỗi bất ngờ', e);
    missing.push('(không kiểm tra được gói tài nguyên)');
  }
  for (const w of warnings) log.warn(w);
  if (missing.length === 0) return { ok: true, missing, warnings };
  log.error('Gói thiếu tài nguyên bắt buộc:', missing.join('; '));
  return {
    ok: false,
    missing,
    warnings,
    error: new AppError('OFFLINE_NOT_READY', NOT_READY_MESSAGE, true, { missing }),
  };
}