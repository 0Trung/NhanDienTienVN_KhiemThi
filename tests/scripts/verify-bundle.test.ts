import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/verify-bundle.mjs', import.meta.url));
const ONNX = Buffer.from('du lieu model gia lap');
const made: string[] = [];

/** Dựng một gói đủ tài nguyên trong thư mục tạm (cấu trúc như android/app/src/main/assets/public). */
function makeBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  made.push(dir);
  for (const sub of ['models', 'ort', 'audio']) mkdirSync(join(dir, sub));
  const write = (rel: string, data: string | Buffer): void => writeFileSync(join(dir, rel), data);
  write('index.html', '<html></html>');
  write('models/classes.json', JSON.stringify({ '0': 1000 }));
  write('models/model-config.json', JSON.stringify({ inputSize: 640 }));
  write('models/best.onnx', ONNX);
  write(
    'models/model-manifest.json',
    JSON.stringify({ file: 'best.onnx', sizeBytes: ONNX.length, sha256: createHash('sha256').update(ONNX).digest('hex') }),
  );
  write('ort/ort-wasm-simd-threaded.wasm', 'wasm');
  write('ort/ort-wasm-simd-threaded.mjs', 'export {};');
  write('ort/ort-files.json', JSON.stringify({ files: ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'] }));
  write('audio/welcome.mp3', 'mp3');
  write('audio/manifest.json', JSON.stringify({ clips: { welcome: 'welcome.mp3' } }));
  return dir;
}

const run = (dir: string) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('verify-bundle.mjs', () => {
  it('gói đủ: thoát mã 0, in bảng dung lượng và tổng assets', () => {
    const result = run(makeBundle());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('models/best.onnx');
    expect(result.stdout).toContain('Tổng dung lượng assets');
    expect(result.stdout).toMatch(/OK\s+models\/best\.onnx: sha256 khớp manifest/);
  });

  it('ort-files.json vắng: vẫn đạt, chỉ ghi chú', () => {
    const dir = makeBundle();
    rmSync(join(dir, 'ort/ort-files.json'));
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Ghi chú: Chưa có ort/ort-files.json');
  });

  it.each([
    { name: 'thiếu file onnx', mutate: (d: string) => rmSync(join(d, 'models/best.onnx')), line: /LỖI\s+models\/best\.onnx \(có mặt\)/ },
    {
      name: 'sai sha256 (cùng kích thước)',
      mutate: (d: string) => writeFileSync(join(d, 'models/best.onnx'), Buffer.from(ONNX.toString().toUpperCase())),
      line: /LỖI\s+models\/best\.onnx: sha256 khớp manifest/,
    },
    {
      name: 'sai kích thước',
      mutate: (d: string) => writeFileSync(join(d, 'models/best.onnx'), Buffer.concat([ONNX, Buffer.from('x')])),
      line: /LỖI\s+models\/best\.onnx: kích thước khớp manifest/,
    },
    { name: 'thiếu model-manifest.json', mutate: (d: string) => rmSync(join(d, 'models/model-manifest.json')), line: /LỖI\s+models\/model-manifest\.json/ },
    { name: 'thiếu wasm', mutate: (d: string) => rmSync(join(d, 'ort/ort-wasm-simd-threaded.wasm')), line: /LỖI\s+ort\/\*\.wasm/ },
    { name: 'thiếu thư mục audio', mutate: (d: string) => rmSync(join(d, 'audio'), { recursive: true }), line: /LỖI\s+audio\/\*/ },
    {
      name: 'ort-files.json liệt kê file không có',
      mutate: (d: string) => writeFileSync(join(d, 'ort/ort-files.json'), JSON.stringify(['ort-wasm-simd-threaded.wasm', 'khong-co.wasm'])),
      line: /LỖI\s+ort\/khong-co\.wasm/,
    },
    { name: 'có Service Worker', mutate: (d: string) => writeFileSync(join(d, 'sw.js'), ''), line: /LỖI\s+không có Service Worker/ },
  ])('$name: thoát mã 1 và chỉ đúng mục lỗi', ({ mutate, line }) => {
    const dir = makeBundle();
    mutate(dir);
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(line);
  });

  it('thư mục không tồn tại: thoát mã 1 và hướng dẫn chạy cap:sync', () => {
    const result = run(join(tmpdir(), 'khong-ton-tai-verify-bundle'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm run cap:sync');
  });
});