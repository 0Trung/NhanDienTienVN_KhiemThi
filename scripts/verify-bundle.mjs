// Kiểm tra gói web trong dự án Android (sau npm run cap:sync) có đủ tài nguyên để chạy ngoại tuyến trong APK.
// Dùng: npm run cap:sync && npm run verify:bundle
//       node scripts/verify-bundle.mjs [thư mục]   (mặc định android/app/src/main/assets/public; truyền "dist" để kiểm tra trước khi sync)
// Thoát mã 1 nếu thiếu tài nguyên, sai kích thước hoặc sai sha256 của file onnx.
// Bản này thay bản P00 (vốn chỉ kiểm tra dist/) và giữ các kiểm tra cũ: index.html, ort/*.mjs, không có Service Worker.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TARGET = join('android', 'app', 'src', 'main', 'assets', 'public');
const AUDIO_FILE = /\.(mp3|ogg|wav|m4a|aac|opus)$/i;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, process.argv[2] ?? DEFAULT_TARGET);
const problems = [];
const notes = [];

const at = (...parts) => join(target, ...parts);
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const fmt = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`);

function listFiles(sub) {
  const dir = at(sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).sort();
}

function totalSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    total += statSync(p).isDirectory() ? totalSize(p) : statSync(p).size;
  }
  return total;
}

function readJson(...parts) {
  try {
    return JSON.parse(readFileSync(at(...parts), 'utf8'));
  } catch {
    return null;
  }
}

function check(label, ok) {
  console.info(`${ok ? 'OK   ' : 'LỖI '}  ${label}`);
  if (!ok) problems.push(label);
  return ok;
}

function sha256(file) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')));
  });
}

/** Định dạng audio/manifest.json không cố định: lấy mọi chuỗi kết thúc bằng đuôi âm thanh, bỏ tiền tố ./ và audio/. */
function collectAudio(value, out = new Set(), depth = 0) {
  if (typeof value === 'string') {
    const name = value.replace(/^(?:\.\/)?(?:audio\/)?/, '');
    if (AUDIO_FILE.test(name) && !name.includes('..') && !name.startsWith('/')) out.add(name);
  } else if (depth < 4 && typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) collectAudio(child, out, depth + 1);
  }
  return out;
}

if (!existsSync(target)) {
  console.error(`[verify:bundle] Không thấy ${target}. Hãy chạy npm run cap:sync (hoặc truyền thư mục đã build, ví dụ: node scripts/verify-bundle.mjs dist).`);
  process.exit(1);
}
console.info(`[verify:bundle] Kiểm tra ${target}\n`);

check('index.html', isFile(at('index.html')));
check('không có Service Worker', !listFiles('').some((f) => /^(sw|service-worker)\.js$/i.test(f)));

// models/*: manifest, classes, config và file onnx (kích thước + sha256)
const manifest = readJson('models', 'model-manifest.json');
const file = typeof manifest?.file === 'string' && /^[\w.-]+$/.test(manifest.file) ? manifest.file : null;
const sizeOk = Number.isSafeInteger(manifest?.sizeBytes) && manifest.sizeBytes > 0;
const shaOk = /^[0-9a-f]{64}$/i.test(String(manifest?.sha256));
check('models/model-manifest.json (có file, sizeBytes, sha256 hợp lệ)', Boolean(file) && sizeOk && shaOk);
check('models/classes.json (đọc được)', readJson('models', 'classes.json') !== null);
check('models/model-config.json (đọc được)', readJson('models', 'model-config.json') !== null);
if (file && sizeOk && shaOk) {
  const onnx = at('models', file);
  if (check(`models/${file} (có mặt)`, isFile(onnx))) {
    const size = statSync(onnx).size;
    check(`models/${file}: kích thước khớp manifest (${size} / ${manifest.sizeBytes} byte)`, size === manifest.sizeBytes);
    check(`models/${file}: sha256 khớp manifest`, (await sha256(onnx)) === manifest.sha256.toLowerCase());
  }
}

// ort/*: wasm, mjs và (nếu có) danh sách bắt buộc trong ort-files.json
const ort = listFiles('ort');
check('ort/*.wasm (có ít nhất một file không rỗng)', ort.some((f) => f.endsWith('.wasm') && statSync(at('ort', f)).size > 0));
check('ort/*.mjs (có ít nhất một file)', ort.some((f) => f.endsWith('.mjs')));
const ortList = readJson('ort', 'ort-files.json');
const ortNames = Array.isArray(ortList) ? ortList : ortList?.files;
if (Array.isArray(ortNames)) {
  for (const name of ortNames.filter((n) => typeof n === 'string')) check(`ort/${name} (theo ort-files.json)`, ort.includes(name));
} else {
  notes.push('Chưa có ort/ort-files.json hợp lệ (scripts/copy-ort-wasm.mjs chưa sinh) nên chưa đối chiếu danh sách file ORT.');
}

// audio/*
check('audio/* (có ít nhất một file âm thanh)', listFiles('audio').some((f) => AUDIO_FILE.test(f)));
const audioList = readJson('audio', 'manifest.json');
if (audioList === null) notes.push('Chưa có audio/manifest.json nên chưa đối chiếu danh sách âm thanh.');
else for (const name of collectAudio(audioList)) check(`audio/${name} (theo audio/manifest.json)`, isFile(at('audio', name)));

console.info('\nTài nguyên chính trong gói:');
for (const sub of ['models', 'ort', 'audio']) {
  for (const f of listFiles(sub)) console.info(`  ${`${sub}/${f}`.padEnd(44)}${fmt(statSync(at(sub, f)).size).padStart(11)}`);
}
console.info(`\nTổng dung lượng assets: ${fmt(totalSize(target))} (ước lượng cỡ APK, chưa tính nén và phần mã Android)`);
for (const note of notes) console.info(`Ghi chú: ${note}`);

if (problems.length > 0) {
  console.error(`\n[verify:bundle] THẤT BẠI, ${problems.length} mục lỗi:\n- ${problems.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.info('\n[verify:bundle] Gói đủ tài nguyên để chạy ngoại tuyến.');
}