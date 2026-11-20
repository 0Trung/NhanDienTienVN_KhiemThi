// Lệnh chạy: npm run metrics:log -- <nhật-ký.csv> [--out report.json]
// Mã thoát: 0 = xong · 2 = sai tham số, không đọc được file hoặc nhật ký sai định dạng.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { computeLogMetrics } from './metrics';
import { LogFormatError, parseLog } from './parse-csv';
import { buildReport, renderMetricsTable } from './report';

const EXIT_OK = 0;
const EXIT_STOPPED = 2;
const DEFAULT_OUT = 'report.json';
const JSON_INDENT = 2;

const USAGE = 'Cách dùng: npm run metrics:log -- <nhật-ký.csv> [--out report.json]';

interface Args {
  input: string;
  out: string;
}

function parseArgs(argv: readonly string[]): Args | string {
  let input: string | null = null;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      const next = argv[++i];
      if (next === undefined) return 'Thiếu giá trị sau --out';
      out = next;
    } else if (arg !== undefined && !arg.startsWith('--') && input === null) input = arg;
    else return `Tham số không hợp lệ: ${String(arg)}`;
  }
  return input === null ? 'Thiếu đường dẫn tới file nhật ký CSV' : { input, out };
}

function run(): number {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    process.stderr.write(`${args}\n${USAGE}\n`);
    return EXIT_STOPPED;
  }
  let text: string;
  try {
    text = readFileSync(args.input, 'utf8');
  } catch {
    process.stderr.write(`Không đọc được file: ${args.input}\n`);
    return EXIT_STOPPED;
  }
  try {
    const metrics = computeLogMetrics(parseLog(text));
    const source = basename(args.input);
    process.stdout.write(renderMetricsTable(source, metrics));
    writeFileSync(args.out, `${JSON.stringify(buildReport(source, metrics), null, JSON_INDENT)}\n`);
    process.stdout.write(`\nĐã ghi ${args.out}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof LogFormatError) {
      process.stderr.write(`Nhật ký sai định dạng: ${error.message}\n`);
      return EXIT_STOPPED;
    }
    throw error;
  }
}

process.exitCode = run();