import { defineConfig } from 'vitest/config';

/** Header cross-origin isolation: CHỈ để thử onnxruntime-web đa luồng trên máy tính (dev/preview). */
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './', // bắt buộc cho Android WebView: mọi đường dẫn tài nguyên là tương đối
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0, // không nhúng tài nguyên vào JS: model/wasm/âm thanh luôn là file riêng
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node', // file nào cần DOM thì khai báo: // @vitest-environment happy-dom
  },
});