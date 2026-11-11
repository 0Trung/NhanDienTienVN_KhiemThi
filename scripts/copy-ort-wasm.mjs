// Chép runtime của onnxruntime-web (file .wasm và .mjs đi kèm, bản SIMD) vào public/ort/
// để APK chứa sẵn và chạy offline. Bỏ biến thể jsep, webgpu, asyncify, jspi.
// Chạy tự động ở postinstall, predev, prebuild.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const destDir = join(root, 'public', 'ort');

const WANTED = /^ort-wasm-simd.*\.(wasm|mjs)$/;
const EXCLUDED = /(jsep|webgpu|asyncify|jspi)/i;

const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

if (!existsSync(srcDir)) {
  console.error(`[copy-ort] Không thấy ${srcDir}. Hãy chạy npm i trước.`);
  process.exit(1);
}

const available = readdirSync(srcDir).sort();
const selected = available.filter((f) => WANTED.test(f) && !EXCLUDED.test(f));

if (!selected.some((f) => f.endsWith('.wasm'))) {
  console.error('[copy-ort] Không tìm thấy file .wasm bản SIMD phù hợp. Các file ort-wasm* hiện có:');
  for (const f of available.filter((x) => x.startsWith('ort-wasm'))) console.error(`  - ${f}`);
  console.error('[copy-ort] Có thể phiên bản onnxruntime-web đổi tên file: hãy sửa WANTED/EXCLUDED trong script này.');
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
// Xóa bản chép cũ để không sót file của phiên bản trước.
for (const old of readdirSync(destDir)) {
  if (old.startsWith('ort-wasm')) rmSync(join(destDir, old), { force: true });
}

let total = 0;
console.info('[copy-ort] Đã chép vào public/ort:');
for (const f of selected) {
  copyFileSync(join(srcDir, f), join(destDir, f));
  const size = statSync(join(destDir, f)).size;
  total += size;
  console.info(`  - ${f}  (${mb(size)})`);
}
console.info(`[copy-ort] Tổng: ${selected.length} file, ${mb(total)}`);
if (!selected.some((f) => f.endsWith('.mjs'))) {
  console.warn('[copy-ort] Cảnh báo: chưa thấy file .mjs đi kèm. Kiểm tra lại phiên bản onnxruntime-web.');
}