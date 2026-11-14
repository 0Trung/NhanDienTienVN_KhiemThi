import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/contracts';
import type { AppErrorCode } from '../../src/contracts';
import { computeLetterbox } from '../../src/vision/letterbox';

function expectAppError(run: () => unknown, code: AppErrorCode): void {
  let caught: unknown;
  try {
    run();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
}

/** Kỳ vọng sinh từ ĐÚNG hàm letterbox() của P01 (Python): [srcW, srcH, inputSize, newWidth, newHeight, padX, padY]. */
const CASES: ReadonlyArray<readonly [number, number, number, number, number, number, number]> = [
  [1280, 720, 640, 640, 360, 0, 140],
  [720, 1280, 640, 360, 640, 140, 0],
  [640, 640, 640, 640, 640, 0, 0],
  [1920, 1080, 640, 640, 360, 0, 140],
  [100, 30, 640, 640, 192, 0, 224],
  [1280, 720, 512, 512, 288, 0, 112],
  [720, 1280, 512, 288, 512, 112, 0],
  [640, 640, 512, 512, 512, 0, 0],
  [1920, 1080, 512, 512, 288, 0, 112],
  [100, 30, 512, 512, 154, 0, 179],
  [1280, 720, 416, 416, 234, 0, 91],
  [720, 1280, 416, 234, 416, 91, 0],
  [640, 640, 416, 416, 416, 0, 0],
  [1920, 1080, 416, 416, 234, 0, 91],
  [100, 30, 416, 416, 125, 0, 145],
];

describe('computeLetterbox', () => {
  it.each(CASES)('%i×%i @%i → %i×%i, lề (%i, %i)', (w, h, s, newWidth, newHeight, padX, padY) => {
    // toEqual phân biệt -0 với 0, nên cũng chặn lề âm không.
    expect(computeLetterbox(w, h, s)).toEqual({
      inputSize: s, srcWidth: w, srcHeight: h, scale: Math.min(s / w, s / h), newWidth, newHeight, padX, padY,
    });
  });

  it.each([[1280, 720, 416], [333, 777, 640], [1, 1, 96], [4032, 3024, 512], [10000, 1, 416], [1, 10000, 416]])(
    '%i×%i @%i: cạnh nguyên ≥ 1, ảnh nằm trong khung, lề = phần nguyên của nửa phần dư',
    (w, h, s) => {
      const m = computeLetterbox(w, h, s);
      expect([m.newWidth, m.newHeight, m.padX, m.padY].every(Number.isInteger)).toBe(true);
      expect(m.newWidth).toBeGreaterThanOrEqual(1);
      expect(m.newHeight).toBeGreaterThanOrEqual(1);
      expect(m.padX + m.newWidth).toBeLessThanOrEqual(s);
      expect(m.padY + m.newHeight).toBeLessThanOrEqual(s);
      expect(m.padX).toBe(Math.floor((s - m.newWidth) / 2));
      expect(m.padY).toBe(Math.floor((s - m.newHeight) / 2));
    },
  );

  it('khung cực dẹt không làm cạnh nhỏ về 0', () => {
    expect(computeLetterbox(10000, 1, 416)).toMatchObject({ newWidth: 416, newHeight: 1, padX: 0, padY: 207 });
  });

  const INVALID: ReadonlyArray<readonly [string, number, number, number]> = [
    ['rộng = 0', 0, 720, 640],
    ['cao = 0', 1280, 0, 640],
    ['rộng âm', -1280, 720, 640],
    ['cao âm', 1280, -720, 640],
    ['rộng NaN', Number.NaN, 720, 640],
    ['cao NaN', 1280, Number.NaN, 640],
    ['cao vô cực', 1280, Number.POSITIVE_INFINITY, 640],
    ['inputSize = 0', 1280, 720, 0],
    ['inputSize âm', 1280, 720, -416],
    ['inputSize NaN', 1280, 720, Number.NaN],
    ['inputSize không nguyên', 1280, 720, 416.5],
  ];
  it.each(INVALID)('kích thước không hợp lệ (%s) ném AppError INFERENCE_FAILED', (_label, w, h, s) => {
    expectAppError(() => computeLetterbox(w, h, s), 'INFERENCE_FAILED');
  });
});