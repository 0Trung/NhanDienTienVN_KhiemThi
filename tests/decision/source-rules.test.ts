// Bảo đảm tĩnh cho nghiệm thu: module decision không chạm DOM, đồng hồ, I/O, không dùng any,
// và chỉ import hợp đồng, cấu hình, tiện ích P00 hoặc file cùng thư mục.
import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob<string>('../../src/decision/*.ts', { query: '?raw', import: 'default', eager: true });

/** Bỏ chú thích để từ cấm nằm trong lời giải thích không gây báo nhầm. */
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const FILES = Object.entries(SOURCES).map(([path, source]) => ({ name: path.split('/').at(-1) ?? path, code: stripComments(source) }));

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: 'đồng hồ hệ thống và bộ hẹn giờ', pattern: /\bDate\b|(?<![.\w])performance\b|\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b/ },
  { name: 'DOM và API trình duyệt', pattern: /(?<![.\w])(document|window|navigator|localStorage|sessionStorage|globalThis)\b|\bHTML\w*Element\b/ },
  { name: 'I/O (mạng, console, worker)', pattern: /\bfetch\b|\bXMLHttpRequest\b|(?<![.\w])console\b|\bWorker\b/ },
  { name: 'số ngẫu nhiên', pattern: /\bMath\.random\b/ },
  { name: 'kiểu any', pattern: /:\s*any\b|\bas\s+any\b|<any>/ },
  { name: 'import động', pattern: /\bimport\s*\(/ },
];
const ALLOWED_IMPORT = /^(\.\/[\w-]+|\.\.\/contracts|\.\.\/config\/[\w-]+|\.\.\/utils\/[\w-]+)$/;

describe('quy tắc mã nguồn của src/decision', () => {
  it('quét đủ các file của module', () => {
    expect(FILES.map((f) => f.name)).toEqual(expect.arrayContaining(['decision-engine.ts', 'state-manager.ts', 'total-calculator.ts']));
  });

  describe.each(FILES)('$name', ({ code }) => {
    it.each(FORBIDDEN)('không dùng $name', ({ pattern }) => {
      expect(code).not.toMatch(pattern);
    });

    it('chỉ import hợp đồng, cấu hình, tiện ích P00 hoặc file cùng thư mục', () => {
      for (const [, specifier = ''] of code.matchAll(/\bfrom\s+'([^']+)'/g)) expect(specifier).toMatch(ALLOWED_IMPORT);
    });
  });
});