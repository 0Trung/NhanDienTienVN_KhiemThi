import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/config/app-config';
import { AppError } from '../../src/contracts';
import { MAX_BINARY_BYTES, assertNoImageData } from '../../src/offline/privacy-guard';
import { makeFakeBitmap } from '../fakes/fake-camera';

/** Node không có ImageData thật: chỉ cần đúng nhãn kiểu như trình duyệt (Symbol.toStringTag). */
const tagged = (tag: string): object => ({ [Symbol.toStringTag]: tag });

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('assertNoImageData: chặn', () => {
  it.each([
    { name: 'ImageBitmap (đồ giả của P00)', value: () => makeFakeBitmap(640, 480) },
    { name: 'ImageData', value: () => tagged('ImageData') },
    { name: 'Blob', value: () => new Blob(['x']) },
    { name: 'ArrayBuffer lớn hơn 4 KB', value: () => new ArrayBuffer(MAX_BINARY_BYTES + 1) },
    { name: 'Uint8Array lớn hơn 4 KB', value: () => new Uint8Array(MAX_BINARY_BYTES + 1) },
    { name: 'Float32Array lớn (tính theo byte)', value: () => new Float32Array(MAX_BINARY_BYTES) },
    { name: 'chuỗi data:image', value: () => 'data:image/png;base64,AAAA' },
    { name: 'chuỗi DATA:IMAGE có khoảng trắng đầu', value: () => '  DATA:image/jpeg;base64,/9j/' },
    { name: 'khung CapturedFrame lồng trong đối tượng', value: () => ({ frame: { bitmap: makeFakeBitmap(1, 1), meta: {} } }) },
    { name: 'mảng byte lớn nằm trong mảng lồng nhau', value: () => [1, [new Uint8Array(5000)]] },
    { name: 'cấu trúc lồng quá sâu (không kiểm chứng được)', value: () => ({ a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }) },
  ])('$name', ({ value }) => {
    const error = caught(() => assertNoImageData(value()));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STORAGE_FAILED');
  });

  it('detail chỉ ghi đường dẫn và lý do, không chứa dữ liệu ảnh', () => {
    const payload = 'data:image/png;base64,SECRETPIXELS';
    const error = caught(() => assertNoImageData({ modelVersion: payload })) as AppError;
    expect(JSON.stringify(error.detail)).toContain('$.modelVersion');
    expect(error.message + JSON.stringify(error.detail)).not.toContain('SECRETPIXELS');
  });
});

describe('assertNoImageData: cho qua', () => {
  it.each([
    { name: 'cài đặt mặc định', value: () => DEFAULT_SETTINGS },
    { name: 'bản vá nhỏ', value: () => ({ fontScale: 1.5, highContrast: true }) },
    { name: 'Uint8Array đúng 4 KB', value: () => new Uint8Array(MAX_BINARY_BYTES) },
    { name: 'ArrayBuffer nhỏ', value: () => new ArrayBuffer(16) },
    { name: 'chuỗi data: không phải ảnh', value: () => 'data:text/plain,abc' },
    { name: 'null, undefined, số, boolean', value: () => [null, undefined, 1, true] },
    {
      name: 'đối tượng vòng tròn không chứa ảnh',
      value: () => {
        const a: Record<string, unknown> = {};
        a.self = a;
        return a;
      },
    },
  ])('$name', ({ value }) => {
    expect(() => assertNoImageData(value())).not.toThrow();
  });
});