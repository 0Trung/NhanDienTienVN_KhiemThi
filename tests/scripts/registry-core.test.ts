import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REGISTRY,
  checkRegistry,
  collectExports,
  countStatuses,
  evaluateRequire,
  isStubSource,
  parseArgs,
  shouldFail,
} from '../../scripts/registry-core';
import type { RegistryRow } from '../../scripts/registry-core';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'registry-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content: string): string {
  const abs = join(root, relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

const row = (prompt: string, file: string, exports: string[]): RegistryRow => ({ prompt, file, exports });

describe('checkRegistry', () => {
  it('phân biệt được THẬT, STUB và THIẾU', () => {
    write('src/real.ts', 'export function a(): number { return 1; }\n');
    write('src/stub.ts', "// STUB P02 — module thật sẽ GHI ĐÈ file này.\nexport function b(): void { throw new Error('STUB'); }\n");
    write('src/partial.ts', 'export function a(): number { return 1; }\n');

    const results = checkRegistry(root, [
      row('P00', 'src/real.ts', ['a']),
      row('P02', 'src/stub.ts', ['b']),
      row('P03', 'src/missing.ts', ['c']),
      row('P04', 'src/partial.ts', ['a', 'b']),
    ]);

    expect(results.map((r) => r.status)).toEqual(['THẬT', 'STUB', 'THIẾU', 'THIẾU']);
    expect(results[2]?.note).toBe('không có file');
    expect(results[3]?.missingExports).toEqual(['b']);
    expect(countStatuses(results)).toEqual({ 'THẬT': 1, STUB: 1, 'THIẾU': 2 });
  });

  it('chỉ dòng ĐẦU mới được tính là dấu STUB', () => {
    write('src/real.ts', '// ghi chú\n// STUB P02 nằm ở dòng hai\nexport const a = 1;\n');
    expect(isStubSource('// ghi chú\n// STUB P02')).toBe(false);
    expect(checkRegistry(root, [row('P02', 'src/real.ts', ['a'])])[0]?.status).toBe('THẬT');
  });

  it('nhận dấu STUB khi file có BOM và xuống dòng kiểu Windows', () => {
    expect(isStubSource('\uFEFF// STUB P05 — x\r\nexport const a = 1;')).toBe(true);
  });

  it('dòng dùng * gộp export của các file và bỏ qua *.test.ts', () => {
    write('tests/fakes/a.ts', 'export class A {}\n');
    write('tests/fakes/b.ts', 'export const B = 1;\n');
    write('tests/fakes/c.test.ts', 'export const C = 1;\n');

    const ok = checkRegistry(root, [row('P00', 'tests/fakes/*.ts', ['A', 'B'])]);
    expect(ok[0]?.status).toBe('THẬT');
    expect(ok[0]?.files).toHaveLength(2);

    const withTestFile = checkRegistry(root, [row('P00', 'tests/fakes/*.ts', ['A', 'B', 'C'])]);
    expect(withTestFile[0]?.status).toBe('THIẾU');
  });

  it('dòng dùng * mà thư mục không tồn tại là THIẾU', () => {
    expect(checkRegistry(root, [row('P00', 'tests/fakes/*.ts', ['A'])])[0]?.status).toBe('THIẾU');
  });

  it('một file stub trong nhóm * làm cả dòng là STUB', () => {
    write('tests/fakes/a.ts', 'export class A {}\n');
    write('tests/fakes/b.ts', '// STUB P00\nexport const B = 1;\n');
    expect(checkRegistry(root, [row('P00', 'tests/fakes/*.ts', ['A', 'B'])])[0]?.status).toBe('STUB');
  });
});

describe('collectExports', () => {
  it.each([
    {
      name: 'hàm, lớp, hằng nhiều khai báo',
      source: 'export function f() {}\nexport class C {}\nexport const x = 1, y = 2;\n',
      expected: ['C', 'f', 'x', 'y'],
    },
    {
      name: 'kiểu, interface, enum',
      source: 'export type T = number;\nexport interface I { a: number }\nexport enum E { A }\n',
      expected: ['E', 'I', 'T'],
    },
    {
      name: 'danh sách export có đổi tên',
      source: 'const a = 1;\nconst b = 2;\nexport { a as renamed, b };\n',
      expected: ['b', 'renamed'],
    },
    {
      name: 'hằng giải cấu trúc',
      source: 'declare const obj: { p: number; q: number };\nexport const { p, q: r } = obj;\n',
      expected: ['p', 'r'],
    },
    {
      name: 'export default',
      source: 'export default function () {}\n',
      expected: ['default'],
    },
    {
      name: 'khai báo không export bị bỏ qua',
      source: 'function hidden() {}\nconst secret = 1;\nexport const shown = secret;\n',
      expected: ['shown'],
    },
  ])('$name', ({ source, expected }) => {
    const file = write('src/sample.ts', source);
    expect([...collectExports(file)].sort()).toEqual(expected);
  });

  it('theo dõi export * from đường dẫn tương đối và chịu được vòng lặp', () => {
    write('src/inner.ts', "export const inner = 1;\nexport * from './outer';\n");
    const outer = write('src/outer.ts', "export const outer = 2;\nexport * from './inner';\n");
    expect([...collectExports(outer)].sort()).toEqual(['inner', 'outer']);
  });

  it('file không tồn tại cho tập rỗng', () => {
    expect(collectExports(join(root, 'nope.ts')).size).toBe(0);
  });
});

describe('evaluateRequire và shouldFail', () => {
  const rows = [row('P00', 'src/real.ts', ['a']), row('P02', 'src/stub.ts', ['b']), row('P03', 'src/none.ts', ['c'])];

  it('prompt STUB hoặc THIẾU hoặc không có trong bảng đều vi phạm --require', () => {
    write('src/real.ts', 'export const a = 1;\n');
    write('src/stub.ts', '// STUB P02\nexport const b = 1;\n');
    const results = checkRegistry(root, rows);

    expect(evaluateRequire(results, ['P00'])).toEqual([]);
    expect(evaluateRequire(results, ['P02'])).toHaveLength(1);
    expect(evaluateRequire(results, ['P03'])).toHaveLength(1);
    expect(evaluateRequire(results, ['P99'])).toHaveLength(1);
  });

  it('shouldFail đúng cho từng tình huống', () => {
    write('src/real.ts', 'export const a = 1;\n');
    write('src/stub.ts', '// STUB P02\nexport const b = 1;\n');
    const noMissing = checkRegistry(root, rows.slice(0, 2));
    const withMissing = checkRegistry(root, rows);

    expect(shouldFail(noMissing, [])).toBe(false);
    expect(shouldFail(noMissing, ['P02: vi phạm'])).toBe(true);
    expect(shouldFail(withMissing, [])).toBe(true);
  });
});

describe('parseArgs', () => {
  it.each([
    { name: 'không tham số', argv: [], require: [] as string[], root: undefined },
    { name: '--require tách riêng, tự viết hoa', argv: ['--require', 'p02, P03'], require: ['P02', 'P03'], root: undefined },
    { name: '--require=...', argv: ['--require=P02'], require: ['P02'], root: undefined },
    { name: '--root tách riêng', argv: ['--root', 'mau'], require: [], root: 'mau' },
    { name: '--root=...', argv: ['--root=mau'], require: [], root: 'mau' },
  ])('$name', ({ argv, require, root: expectedRoot }) => {
    const parsed = parseArgs(argv);
    expect(parsed.error).toBeUndefined();
    expect(parsed.require).toEqual(require);
    expect(parsed.root).toBe(expectedRoot);
  });

  it.each([['--bogus'], ['--require'], ['--root']])('%s báo lỗi', (...argv) => {
    expect(parseArgs(argv).error).toBeDefined();
  });
});

describe('REGISTRY khớp docs/export-registry.txt', () => {
  const docPath = fileURLToPath(new URL('../../docs/export-registry.txt', import.meta.url));

  const docRows = readFileSync(docPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.startsWith('PROMPT'))
    .map((line) => {
      const [prompt = '', file = '', exportsColumn = ''] = line.split(' | ');
      return {
        prompt: prompt.trim(),
        file: file.trim(),
        exports: exportsColumn.split(',').map((e) => e.trim()).filter((e) => e !== ''),
      };
    });

  it('cùng số dòng, cùng prompt và cùng đường dẫn theo thứ tự', () => {
    expect(REGISTRY.map((r) => [r.prompt, r.file])).toEqual(docRows.map((r) => [r.prompt, r.file]));
  });

  it('cột EXPORT của tài liệu và REGISTRY giống nhau từng dòng (không phân biệt thứ tự)', () => {
    for (const registryRow of REGISTRY) {
      const docRow = docRows.find((d) => d.file === registryRow.file);
      expect(docRow, registryRow.file).toBeDefined();
      expect([...(docRow?.exports ?? [])].sort(), registryRow.file).toEqual([...registryRow.exports].sort());
    }
  });
});