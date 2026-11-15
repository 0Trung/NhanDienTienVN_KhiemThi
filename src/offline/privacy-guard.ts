import { AppError } from '../contracts';

/** Mảng byte lớn hơn mức này (4 KB) bị coi là có thể chứa ảnh. */
export const MAX_BINARY_BYTES = 4 * 1024;
/** Độ sâu tối đa khi duyệt giá trị lồng nhau; sâu hơn thì không kiểm chứng được nên từ chối. */
const MAX_DEPTH = 8;

/** Kiểu đối tượng luôn bị chặn, nhỏ hay lớn đều không được lưu (ảnh và khối nhị phân dạng tệp). */
const BLOCKED_TYPES: ReadonlySet<string> = new Set([
  'ImageBitmap',
  'ImageData',
  'Blob',
  'File',
  'VideoFrame',
  'OffscreenCanvas',
  'HTMLCanvasElement',
]);
const DATA_IMAGE = /^\s*data:image/i;

interface Finding {
  path: string;
  reason: string;
}

/** Nhãn kiểu theo Symbol.toStringTag, đúng cả khi khác realm. */
function typeOf(value: object): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

/** Nhận diện ImageBitmap theo hình dạng (width, height, close) phòng khi môi trường không có lớp thật, như Node hay đồ giả. */
function looksLikeBitmap(value: object): boolean {
  const o = value as { width?: unknown; height?: unknown; close?: unknown };
  return typeof o.close === 'function' && typeof o.width === 'number' && typeof o.height === 'number';
}

/** Số byte nếu value là ArrayBuffer hoặc TypedArray/DataView, ngược lại null. */
function byteLengthOf(value: object, type: string): number | null {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (type === 'ArrayBuffer' || type === 'SharedArrayBuffer') return (value as ArrayBuffer).byteLength;
  return null;
}

function inspect(value: unknown, path: string, depth: number, seen: WeakSet<object>): Finding | null {
  if (typeof value === 'string') return DATA_IMAGE.test(value) ? { path, reason: 'chuỗi data:image' } : null;
  if (typeof value !== 'object' || value === null || seen.has(value)) return null;
  seen.add(value);

  const type = typeOf(value);
  if (BLOCKED_TYPES.has(type)) return { path, reason: type };
  if (looksLikeBitmap(value)) return { path, reason: 'ImageBitmap' };

  const bytes = byteLengthOf(value, type);
  if (bytes !== null) return bytes > MAX_BINARY_BYTES ? { path, reason: `mảng byte ${bytes} byte` } : null;

  if (depth >= MAX_DEPTH) return { path, reason: 'lồng quá sâu, không kiểm chứng được' };
  for (const [key, child] of Object.entries(value)) {
    const found = inspect(child, `${path}.${key}`, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

/**
 * Ném AppError STORAGE_FAILED nếu giá trị sắp lưu chứa ảnh: ImageBitmap, ImageData, Blob (cùng File, VideoFrame, canvas),
 * ArrayBuffer/TypedArray lớn hơn 4 KB, hoặc chuỗi bắt đầu bằng data:image. Duyệt cả giá trị lồng nhau.
 * `detail` của lỗi chỉ ghi đường dẫn và lý do, KHÔNG chứa dữ liệu.
 */
export function assertNoImageData(value: unknown): void {
  const found = inspect(value, '$', 0, new WeakSet());
  if (found) {
    throw new AppError('STORAGE_FAILED', `Từ chối lưu dữ liệu hình ảnh (${found.reason}) tại "${found.path}".`, false, found);
  }
}