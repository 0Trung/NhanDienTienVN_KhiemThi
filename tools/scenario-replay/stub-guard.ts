// Chặn chạy khi FrameAnalyzer hoặc DecisionEngine vẫn là stub của P00 (dòng đầu chứa "// STUB").
// Cùng quy ước với scripts/registry-core.ts (isStubSource); viết lại ở đây để công cụ không phụ thuộc node:fs hay typescript.

/** Hai file thật mà công cụ cần, theo bảng đăng ký xuất khẩu (docs/export-registry.txt). */
export const GUARDED_SOURCES = [
  { prompt: 'P06', exportName: 'createFrameAnalyzer', file: 'src/analyzer/frame-analyzer.ts' },
  { prompt: 'P07', exportName: 'createDecisionEngine', file: 'src/decision/decision-engine.ts' },
] as const;

const STUB_MARK = /\/\/\s*STUB\b/;

/** File là stub khi DÒNG ĐẦU chứa "// STUB" (bỏ qua BOM). */
export function isStubSource(text: string): boolean {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const newline = body.search(/\r?\n/);
  return STUB_MARK.test(newline === -1 ? body : body.slice(0, newline));
}

/** Nội dung một file cần kiểm; text = null nghĩa là không đọc được (thiếu file). */
export interface GuardInput {
  file: string;
  text: string | null;
}

export interface GuardProblem {
  kind: 'STUB' | 'MISSING';
  file: string;
}

/** Trả danh sách vấn đề; rỗng nghĩa là cả hai module đều là mã thật. */
export function checkImplemented(inputs: readonly GuardInput[]): GuardProblem[] {
  return inputs.flatMap((i): GuardProblem[] => {
    if (i.text === null) return [{ kind: 'MISSING', file: i.file }];
    return isStubSource(i.text) ? [{ kind: 'STUB', file: i.file }] : [];
  });
}

/** Thông báo tiếng Việt cho người dùng, nói rõ file nào và vì sao công cụ dừng. */
export function describeProblems(problems: readonly GuardProblem[]): string {
  const lines = problems.map((p) => {
    const source = GUARDED_SOURCES.find((s) => s.file === p.file);
    const owner = source === undefined ? '' : ` (${source.prompt}: ${source.exportName})`;
    return p.kind === 'STUB'
      ? `- ${p.file}${owner} vẫn là STUB (dòng đầu có "// STUB").`
      : `- ${p.file}${owner} không đọc được hoặc không tồn tại.`;
  });
  return [
    'DỪNG: công cụ phát lại kịch bản cần mã thật của FrameAnalyzer và DecisionEngine, nhưng:',
    ...lines,
    'Hãy ghép mã thật của các prompt trên vào repo rồi chạy lại. Không có số liệu nào được tạo ra.',
  ].join('\n');
}