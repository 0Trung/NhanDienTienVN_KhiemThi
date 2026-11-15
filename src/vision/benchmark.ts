import { AppError } from '../contracts';
import type { CapturedFrame, IInferenceClient } from '../contracts';
import { createLogger } from '../utils/logger';
import { mean } from '../utils/math';

const log = createLogger('benchmark');

export interface Stats { mean: number; p50: number; p95: number }

/** Phân vị theo "nearest-rank" trên mảng đã sắp tăng dần. */
function percentile(sorted: readonly number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function summarize(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  return { mean: mean(sorted), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

const row = (name: string, s: Stats): string =>
  `| ${name.padEnd(8)} | ${s.mean.toFixed(1).padStart(9)} | ${s.p50.toFixed(1).padStart(8)} | ${s.p95.toFixed(1).padStart(8)} |`;

/**
 * Chạy n khung tuần tự qua client rồi thống kê timings (ms) do worker đo: totalMs (tiền xử lý + ONNX + hậu xử lý) và inferMs.
 * Dùng để chọn size mô hình và targetFps trên điện thoại thật. Bảng được in ở mức info: nếu chạy trong bản
 * production (logger mặc định chỉ ghi warn) hãy gọi setLogLevel('info') trước.
 */
export async function runBenchmark(
  client: IInferenceClient,
  makeFrame: () => Promise<CapturedFrame>,
  n: number,
): Promise<{ totalMs: Stats; inferMs: Stats }> {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`runBenchmark: n phải là số nguyên dương, nhận ${String(n)}`);
  const totals: number[] = [];
  const infers: number[] = [];
  for (let i = 0; i < n; i++) {
    const result = await client.infer(await makeFrame());
    if (result === null) continue; // khung bị bỏ: không tính vào thống kê
    totals.push(result.timings.totalMs);
    infers.push(result.timings.inferMs);
  }
  if (totals.length === 0) throw new AppError('INFERENCE_FAILED', 'Benchmark: không khung nào được xử lý (tất cả bị bỏ).');
  const stats = { totalMs: summarize(totals), inferMs: summarize(infers) };
  log.info(`Benchmark: ${totals.length}/${n} khung được xử lý`);
  log.info('| chỉ số   | mean (ms) | p50 (ms) | p95 (ms) |');
  log.info(row('totalMs', stats.totalMs));
  log.info(row('inferMs', stats.inferMs));
  return stats;
}

/** Nguồn khung giả cho runBenchmark: canvas một màu đúng kích thước camera, mỗi lần gọi trả một ImageBitmap mới. */
export function createSolidFrameSource(width: number, height: number): () => Promise<CapturedFrame> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new AppError('UNSUPPORTED_BROWSER', 'Không tạo được canvas 2D để sinh khung giả.');
  ctx.fillStyle = 'rgb(128, 128, 128)';
  ctx.fillRect(0, 0, width, height);
  let frameId = 0;
  return async () => {
    frameId += 1;
    return { bitmap: await createImageBitmap(canvas), meta: { frameId, width, height, timestamp: performance.now() } };
  };
}
