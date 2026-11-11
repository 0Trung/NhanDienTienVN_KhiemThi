// Kiểm tra gói đã build (mặc định dist/) có đủ tài nguyên để chạy offline trong APK.
// Dùng: npm run build && npm run verify:bundle   (hoặc: node scripts/verify-bundle.mjs <thư mục>)
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, process.argv[2] ?? 'dist');
const problems = [];

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
}

function check(label, ok) {
  console.info(`${ok ? 'OK   ' : 'THIẾU'}  ${label}`);
  if (!ok) problems.push(label);
}

if (!existsSync(target)) {
  console.error(`[verify:bundle] Không thấy ${target}. Hãy chạy npm run build trước.`);
  process.exit(1);
}

const models = listFiles(join(target, 'models'));
const ort = listFiles(join(target, 'ort'));
const hasOnnx = models.some((f) => f.endsWith('.onnx') && statSync(join(target, 'models', f)).size > 0);

check('index.html', existsSync(join(target, 'index.html')));
check('models/*.onnx (không rỗng)', hasOnnx);
check('models/classes.json', models.includes('classes.json'));
check('models/model-config.json', models.includes('model-config.json'));
check('ort/*.wasm', ort.some((f) => f.endsWith('.wasm')));
check('ort/*.mjs', ort.some((f) => f.endsWith('.mjs')));
check('không có Service Worker', !listFiles(target).some((f) => /^(sw|service-worker)\.js$/i.test(f)));

if (problems.length > 0) {
  console.error(`[verify:bundle] Thiếu ${problems.length} mục. Model và classes.json do P01 sinh vào public/models.`);
  process.exit(1);
}
console.info('[verify:bundle] Gói đủ tài nguyên để chạy offline.');