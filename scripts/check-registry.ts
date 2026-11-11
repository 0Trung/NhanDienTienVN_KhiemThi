// Chạy: npm run check:registry            (in trạng thái từng dòng của bảng đăng ký)
//       npm run check:registry -- --require P02,P03   (các prompt này phải THẬT, nếu không thoát mã 1)
// Chỉ đọc cú pháp bằng TypeScript Compiler API, KHÔNG thực thi mã của module.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRegistry, evaluateRequire, formatReport, parseArgs, shouldFail } from './registry-core';

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`[check:registry] ${args.error}`);
    console.error('Dùng: npm run check:registry -- [--require P02,P03] [--root <thư mục>]');
    process.exitCode = 1;
    return;
  }

  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const results = checkRegistry(args.root ? resolve(args.root) : defaultRoot);
  for (const line of formatReport(results)) console.info(line);

  const violations = evaluateRequire(results, args.require);
  for (const violation of violations) console.error(`[check:registry] ${violation}`);
  if (shouldFail(results, violations)) process.exitCode = 1;
}

main();