/**
 * P03 · F1 — Hình học letterbox: đưa khung srcW × srcH vào ảnh vuông inputSize × inputSize, giữ tỷ lệ.
 * Khớp từng bước với hàm letterbox() ở bản mẫu P01 (CELL 5) và Ultralytics LetterBox (center = true).
 * Hàm thuần: không đụng DOM, chạy được trong Node và Web Worker.
 */
import { AppError } from '../contracts';
import type { LetterboxMeta } from '../contracts';

/** Số hữu hạn và > 0: loại 0, số âm, NaN, ±Infinity. */
function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** Cạnh sau resize: làm tròn, tối thiểu 1 (như max(round(...), 1) ở P01), không vượt inputSize. */
function resizedSide(src: number, scale: number, inputSize: number): number {
  return Math.min(inputSize, Math.max(1, Math.round(src * scale)));
}

/** Lề trái/trên = round((S − cạnh mới)/2 − 0,1). "+ 0" đổi -0 (Math.round(-0,1)) thành +0. */
function padFor(inputSize: number, newSide: number): number {
  return Math.round((inputSize - newSide) / 2 - 0.1) + 0;
}

/**
 * scale = min(S/w, S/h) · newW, newH = làm tròn · padX = round((S − newW)/2 − 0,1), padY tương tự.
 * Math.round khác round của Python (làm tròn về số chẵn) chỉ ở điểm đúng .5; bản mẫu P01 đã chấp nhận chênh lệch này.
 * @throws AppError INFERENCE_FAILED khi kích thước khung hoặc inputSize không hợp lệ (0, âm, NaN, vô cực, inputSize không nguyên).
 */
export function computeLetterbox(srcW: number, srcH: number, inputSize: number): LetterboxMeta {
  if (!isPositiveFinite(srcW) || !isPositiveFinite(srcH)) {
    throw new AppError('INFERENCE_FAILED', `Kích thước khung hình không hợp lệ: ${String(srcW)}×${String(srcH)}`, false, {
      srcW,
      srcH,
    });
  }
  if (!Number.isInteger(inputSize) || inputSize <= 0) {
    throw new AppError('INFERENCE_FAILED', `inputSize không hợp lệ: ${String(inputSize)}`, false, { inputSize });
  }
  const scale = Math.min(inputSize / srcW, inputSize / srcH);
  const newWidth = resizedSide(srcW, scale, inputSize);
  const newHeight = resizedSide(srcH, scale, inputSize);
  return {
    inputSize,
    srcWidth: srcW,
    srcHeight: srcH,
    scale,
    newWidth,
    newHeight,
    padX: padFor(inputSize, newWidth),
    padY: padFor(inputSize, newHeight),
  };
}