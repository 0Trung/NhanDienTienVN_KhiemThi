// Lệnh chạy: npm run replay:scenarios [-- --seed N --seeds K]
// Mã thoát: 0 = đạt mục tiêu (Unsafe Read Rate chính = 0) · 1 = không đạt · 2 = dừng (stub, thiếu file, sai tham số).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SEED } from './replay';
import { ALL_SCENARIOS } from './scenarios';
import { GUARDED_SOURCES, checkImplemented, describeProblems } from './stub-guard';
import type { GuardInput } from './stub-guard';

const EXIT_OK = 0;
const EXIT_NOT_MET = 1;
const EXIT_STOPPED = 2;

const USAGE = [
  'Cách dùng: npm run replay:scenarios [-- --seed N] [-- --seeds K]',
  '  --seed N    seed đầu tiên (mặc định ' + String(DEFAULT_SEED) + ')',
  '  --seeds K   quét K seed liên tiếp để tìm lỗi hiếm do nhiễu (mặc định 1)',
].join('\n');

interface Args {
  seed: number;
  seedCount: number;
}

/** Đọc tham số dòng lệnh; trả chuỗi lỗi nếu sai. */
function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { seed: DEFAULT_SEED, seedCount: 1 };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const raw = argv[i + 1];
    const value = raw === undefined ? Number.NaN : Number(raw);
    if (flag === '--seed' && Number.isInteger(value)) args.seed = value;
    else if (flag === '--seeds' && Number.isInteger(value) && value >= 1) args.seedCount = value;
    else return `Tham số không hợp lệ: ${String(flag)} ${String(raw)}`;
  }
  return args;
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    process.stderr.write(`${args}\n${USAGE}\n`);
    return EXIT_STOPPED;
  }

  // Chặn trước khi import mã thật: stub thì dừng và nói rõ, không in số liệu nào.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const inputs: GuardInput[] = GUARDED_SOURCES.map((s) => ({ file: s.file, text: readIfExists(resolve(root, s.file)) }));
  const problems = checkImplemented(inputs);
  if (problems.length > 0) {
    process.stderr.write(`${describeProblems(problems)}\n`);
    return EXIT_STOPPED;
  }

  const { realDeps } = await import('./real-deps');
  const { runSweep, designGoalMet } = await import('./suite');
  const { renderReport } = await import('./report');
  const sweep = runSweep(ALL_SCENARIOS, realDeps, { seed: args.seed, seedCount: args.seedCount });
  process.stdout.write(renderReport(sweep));
  return designGoalMet(sweep) ? EXIT_OK : EXIT_NOT_MET;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Lỗi không mong đợi: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = EXIT_STOPPED;
  },
);