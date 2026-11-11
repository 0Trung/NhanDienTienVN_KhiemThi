/**
 * Giới hạn v vào đoạn [lo, hi]. Nếu lo > hi thì hai đầu mút được hoán đổi.
 * v là NaN thì trả về đầu mút dưới.
 */
export function clamp(v: number, lo: number, hi: number): number {
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  if (Number.isNaN(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** Trung bình cộng; mảng rỗng trả 0. */
export function mean(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += xs[i] ?? 0;
  return sum / n;
}

/** Bộ sinh số giả ngẫu nhiên mulberry32: cùng seed cho cùng dãy, giá trị trong [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}