import { describe, expect, it } from 'vitest';
import { GUARDED_SOURCES, checkImplemented, describeProblems, isStubSource } from '../../tools/scenario-replay/stub-guard';

describe('isStubSource', () => {
  it.each([
    { text: '// STUB\nexport const x = 1;', stub: true, why: 'dòng đầu là // STUB' },
    { text: '// STUB: sẽ có ở P06\nexport {};', stub: true, why: 'dòng đầu có // STUB kèm chú thích' },
    { text: '\uFEFF// STUB\r\nexport {};', stub: true, why: 'có BOM và xuống dòng CRLF' },
    { text: '// STUB', stub: true, why: 'file chỉ có một dòng' },
    { text: 'export const x = 1;\n// STUB', stub: false, why: 'STUB không nằm ở dòng đầu' },
    { text: '// STUBBORN\nexport {};', stub: false, why: 'STUBBORN không phải từ STUB' },
    { text: '', stub: false, why: 'file rỗng' },
    { text: '/** Phân tích khung. */\nexport function createFrameAnalyzer() {}', stub: false, why: 'mã thật' },
  ])('$why', ({ text, stub }) => {
    expect(isStubSource(text)).toBe(stub);
  });
});

describe('checkImplemented', () => {
  const real = { file: 'src/analyzer/frame-analyzer.ts', text: 'export const a = 1;' };

  it('mã thật cả hai file thì không có vấn đề', () => {
    expect(checkImplemented([real, { file: 'src/decision/decision-engine.ts', text: 'export const b = 2;' }])).toEqual([]);
  });

  it('báo STUB cho file còn là stub', () => {
    expect(checkImplemented([real, { file: 'src/decision/decision-engine.ts', text: '// STUB\n' }])).toEqual([
      { kind: 'STUB', file: 'src/decision/decision-engine.ts' },
    ]);
  });

  it('báo MISSING cho file không đọc được', () => {
    expect(checkImplemented([{ file: 'src/analyzer/frame-analyzer.ts', text: null }])).toEqual([
      { kind: 'MISSING', file: 'src/analyzer/frame-analyzer.ts' },
    ]);
  });

  it('danh sách file cần kiểm là hai module theo bảng đăng ký (P06 và P07)', () => {
    expect(GUARDED_SOURCES.map((s) => [s.prompt, s.exportName, s.file])).toEqual([
      ['P06', 'createFrameAnalyzer', 'src/analyzer/frame-analyzer.ts'],
      ['P07', 'createDecisionEngine', 'src/decision/decision-engine.ts'],
    ]);
  });
});

describe('describeProblems', () => {
  it('nói rõ file nào, prompt nào, vì sao dừng và không có số liệu nào được tạo', () => {
    const text = describeProblems([
      { kind: 'STUB', file: 'src/analyzer/frame-analyzer.ts' },
      { kind: 'MISSING', file: 'src/decision/decision-engine.ts' },
    ]);
    expect(text).toContain('DỪNG');
    expect(text).toContain('src/analyzer/frame-analyzer.ts (P06: createFrameAnalyzer) vẫn là STUB');
    expect(text).toContain('src/decision/decision-engine.ts (P07: createDecisionEngine) không đọc được');
    expect(text).toContain('Không có số liệu nào được tạo ra');
  });
});