import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import ts from 'typescript';

export type RowStatus = 'THẬT' | 'STUB' | 'THIẾU';

export interface RegistryRow {
  prompt: string;
  /** Đường dẫn tương đối từ gốc repo. Tên file có thể chứa * (ví dụ tests/fakes/*.ts). */
  file: string;
  exports: readonly string[];
}

export interface RowResult {
  row: RegistryRow;
  status: RowStatus;
  files: string[];
  missingExports: string[];
  note?: string;
}

/**
 * Bảng đăng ký xuất khẩu (Khối B, mục 3.3), chép từ docs/export-registry.txt.
 * Các kiểu phụ ghi trong cột chữ ký (Stats, SettingsItem, AppDeps) được tính là export bắt buộc.
 */
export const REGISTRY: readonly RegistryRow[] = [
  { prompt: 'P00', file: 'src/utils/event-bus.ts', exports: ['createEventBus'] },
  { prompt: 'P00', file: 'src/utils/logger.ts', exports: ['createLogger', 'getRecentLogs'] },
  {
    prompt: 'P00',
    file: 'src/utils/geometry.ts',
    exports: ['area', 'intersectionArea', 'iou', 'overlapOverMin', 'center', 'clampBox', 'isValidBox'],
  },
  { prompt: 'P00', file: 'src/utils/math.ts', exports: ['clamp', 'mean', 'mulberry32'] },
  { prompt: 'P00', file: 'src/utils/time.ts', exports: ['Clock', 'systemClock', 'createFakeClock'] },
  { prompt: 'P00', file: 'src/utils/platform.ts', exports: ['getPlatform', 'isNative'] },
  { prompt: 'P00', file: 'src/config/denominations.ts', exports: ['formatVND', 'isDenomination', 'buildClassMap'] },
  {
    prompt: 'P00',
    file: 'tests/fakes/*.ts',
    exports: [
      'makeDetection', 'makeAnalysis', 'makeInferenceResult', 'FakeCamera', 'FakeInference',
      'FakeTtsEngine', 'FakeSpeech', 'FakeHaptics', 'MemorySettingsStore',
    ],
  },
  { prompt: 'P02', file: 'src/camera/camera-controller.ts', exports: ['createCameraService'] },
  { prompt: 'P03', file: 'src/vision/letterbox.ts', exports: ['computeLetterbox'] },
  { prompt: 'P03', file: 'src/vision/image-processor.ts', exports: ['createPreprocessor'] },
  { prompt: 'P04', file: 'src/vision/post-processor.ts', exports: ['createPostProcessor'] },
  { prompt: 'P05', file: 'src/vision/inference-client.ts', exports: ['createInferenceClient'] },
  { prompt: 'P05', file: 'src/vision/benchmark.ts', exports: ['runBenchmark', 'Stats'] },
  { prompt: 'P06', file: 'src/analyzer/frame-analyzer.ts', exports: ['createFrameAnalyzer'] },
  { prompt: 'P07', file: 'src/decision/decision-engine.ts', exports: ['createDecisionEngine'] },
  { prompt: 'P07', file: 'src/decision/total-calculator.ts', exports: ['calculateTotal'] },
  { prompt: 'P08', file: 'src/voice/speech-manager.ts', exports: ['createSpeechManager'] },
  { prompt: 'P08', file: 'src/voice/native-tts-engine.ts', exports: ['createNativeTtsEngine'] },
  { prompt: 'P08', file: 'src/voice/web-speech-engine.ts', exports: ['createWebSpeechEngine'] },
  { prompt: 'P08', file: 'src/voice/audio-clip-engine.ts', exports: ['createAudioClipEngine'] },
  { prompt: 'P08', file: 'src/voice/haptic-service.ts', exports: ['createHaptics'] },
  { prompt: 'P09', file: 'src/offline/settings-store.ts', exports: ['createSettingsStore'] },
  { prompt: 'P09', file: 'src/offline/asset-check.ts', exports: ['checkBundledAssets'] },
  { prompt: 'P10', file: 'src/accessibility/start-gate.ts', exports: ['createStartGate'] },
  { prompt: 'P10', file: 'src/accessibility/gesture-controller.ts', exports: ['createGestureController'] },
  { prompt: 'P10', file: 'src/accessibility/accessibility-manager.ts', exports: ['createAccessibilityManager'] },
  { prompt: 'P10', file: 'src/accessibility/aria-live-engine.ts', exports: ['createAriaLiveEngine'] },
  { prompt: 'P10', file: 'src/accessibility/settings-manager.ts', exports: ['createSettingsManager'] },
  {
    prompt: 'P10',
    file: 'src/accessibility/settings-view-model.ts',
    exports: ['buildSettingsViewModel', 'SettingsItem'],
  },
  { prompt: 'P11', file: 'src/app/app.ts', exports: ['createApp', 'AppDeps'] },
  { prompt: 'P11', file: 'src/app/native-torch.ts', exports: ['createNativeTorchPort'] },
];

/* ───── Nhận biết file stub ───── */

const STUB_MARK = /\/\/\s*STUB\b/;

function firstLine(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const index = body.search(/\r?\n/);
  return index === -1 ? body : body.slice(0, index);
}

/** File là stub khi DÒNG ĐẦU chứa "// STUB". */
export function isStubSource(text: string): boolean {
  return STUB_MARK.test(firstLine(text));
}

/* ───── Đọc export bằng TypeScript Compiler API (không thực thi mã) ───── */

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
}

function addBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) addBindingNames(element.name, out);
  }
}

function resolveModule(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.replace(/\.(js|mjs|ts|tsx)$/, '');
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, join(base, 'index.ts')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

/** Tập tên export của một file (kể cả kiểu, interface, và export * from './x' tương đối). */
export function collectExports(file: string, visited: Set<string> = new Set()): Set<string> {
  const names = new Set<string>();
  const abs = resolve(file);
  if (visited.has(abs) || !existsSync(abs)) return names;
  visited.add(abs);

  const source = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.add(element.name.text);
      } else if (clause && ts.isNamespaceExport(clause)) {
        names.add(clause.name.text);
      } else if (!clause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveModule(abs, statement.moduleSpecifier.text);
        if (target) for (const n of collectExports(target, visited)) names.add(n);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      names.add('default');
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      names.add('default');
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBindingNames(declaration.name, names);
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      if (statement.name) names.add(statement.name.text);
    }
  }
  return names;
}

/* ───── Kiểm tra bảng đăng ký ───── */

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*');
  return new RegExp(`^${escaped}$`);
}

/** Các file ứng với một dòng bảng; hỗ trợ * trong tên file (bỏ qua *.test.ts). */
export function resolveRowFiles(root: string, file: string): string[] {
  const abs = join(root, file);
  if (!basename(file).includes('*')) {
    return existsSync(abs) && statSync(abs).isFile() ? [abs] : [];
  }
  const dir = dirname(abs);
  if (!existsSync(dir)) return [];
  const pattern = globToRegExp(basename(file));
  return readdirSync(dir)
    .filter((name) => pattern.test(name) && !/\.test\.ts$/.test(name))
    .sort()
    .map((name) => join(dir, name));
}

function checkRow(root: string, row: RegistryRow): RowResult {
  const files = resolveRowFiles(root, row.file);
  if (files.length === 0) {
    return { row, status: 'THIẾU', files, missingExports: [...row.exports], note: 'không có file' };
  }
  const found = new Set<string>();
  for (const file of files) for (const name of collectExports(file)) found.add(name);
  const missingExports = row.exports.filter((name) => !found.has(name));
  if (missingExports.length > 0) return { row, status: 'THIẾU', files, missingExports };
  const hasStub = files.some((file) => isStubSource(readFileSync(file, 'utf8')));
  return { row, status: hasStub ? 'STUB' : 'THẬT', files, missingExports: [] };
}

/** Kiểm tra từng dòng của bảng đăng ký dưới thư mục gốc `root`. */
export function checkRegistry(root: string, rows: readonly RegistryRow[] = REGISTRY): RowResult[] {
  return rows.map((row) => checkRow(root, row));
}

function groupByPrompt(results: readonly RowResult[]): Map<string, RowResult[]> {
  const groups = new Map<string, RowResult[]>();
  for (const result of results) {
    const list = groups.get(result.row.prompt);
    if (list) list.push(result);
    else groups.set(result.row.prompt, [result]);
  }
  return groups;
}

/** Trạng thái của cả prompt: THIẾU nếu có dòng THIẾU; THẬT nếu mọi dòng THẬT; còn lại STUB. */
function summarizePrompt(rows: readonly RowResult[]): RowStatus {
  if (rows.some((r) => r.status === 'THIẾU')) return 'THIẾU';
  if (rows.every((r) => r.status === 'THẬT')) return 'THẬT';
  return 'STUB';
}

export function countStatuses(results: readonly RowResult[]): Record<RowStatus, number> {
  const counts: Record<RowStatus, number> = { 'THẬT': 0, STUB: 0, 'THIẾU': 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

/** Các prompt trong --require phải THẬT. Trả danh sách vi phạm (rỗng nếu ổn). */
export function evaluateRequire(results: readonly RowResult[], required: readonly string[]): string[] {
  const groups = groupByPrompt(results);
  const violations: string[] = [];
  for (const prompt of required) {
    const rows = groups.get(prompt);
    if (!rows) {
      violations.push(`${prompt}: không có trong bảng đăng ký`);
      continue;
    }
    const status = summarizePrompt(rows);
    if (status !== 'THẬT') violations.push(`${prompt}: yêu cầu THẬT nhưng đang là ${status}`);
  }
  return violations;
}

/** Thoát mã 1 khi có dòng THIẾU hoặc vi phạm --require. */
export function shouldFail(results: readonly RowResult[], violations: readonly string[]): boolean {
  return violations.length > 0 || results.some((r) => r.status === 'THIẾU');
}

/** Bảng in ra, nhóm theo prompt. */
export function formatReport(results: readonly RowResult[]): string[] {
  const lines: string[] = [];
  for (const [prompt, rows] of groupByPrompt(results)) {
    lines.push(`${prompt}  →  ${summarizePrompt(rows)}`);
    for (const r of rows) {
      let detail = '';
      if (r.note) detail = `  (${r.note})`;
      else if (r.missingExports.length > 0) detail = `  thiếu: ${r.missingExports.join(', ')}`;
      lines.push(`  ${r.status.padEnd(5)}  ${r.row.file}  [${r.row.exports.join(', ')}]${detail}`);
    }
  }
  const counts = countStatuses(results);
  lines.push('');
  lines.push(`Tổng: ${counts['THẬT']} THẬT · ${counts.STUB} STUB · ${counts['THIẾU']} THIẾU`);
  return lines;
}

/* ───── Tham số dòng lệnh ───── */

export interface CliArgs {
  require: string[];
  root?: string;
  error?: string;
}

/** Hỗ trợ: --require P02,P03 | --require=P02,P03 | --root <thư mục> | --root=<thư mục>. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { require: [] };
  const splitPrompts = (value: string): string[] =>
    value.split(',').map((p) => p.trim().toUpperCase()).filter((p) => p.length > 0);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '--require' || token === '--root') {
      const value = argv[i + 1];
      if (value === undefined) return { ...args, error: `${token} cần một giá trị` };
      if (token === '--require') args.require.push(...splitPrompts(value));
      else args.root = value;
      i += 1;
    } else if (token.startsWith('--require=')) {
      args.require.push(...splitPrompts(token.slice('--require='.length)));
    } else if (token.startsWith('--root=')) {
      args.root = token.slice('--root='.length);
    } else {
      return { ...args, error: `tham số không hợp lệ: ${token}` };
    }
  }
  return args;
}