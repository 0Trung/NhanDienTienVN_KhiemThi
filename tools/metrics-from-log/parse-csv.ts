// Đọc nhật ký thử nghiệm thật (CSV) thành các dòng có kiểu. Hàm thuần: nhận chuỗi, không đọc file.
// Mọi lỗi dữ liệu ném LogFormatError có số dòng và tên cột để người thử nghiệm sửa được ngay.

/** Các cột bắt buộc, đúng thứ tự trong tài liệu thiết kế (mục 13.4). Cột thừa được bỏ qua, thứ tự cột tuỳ ý. */
export const REQUIRED_COLUMNS = [
  'timestamp', 'scenarioId', 'state', 'status', 'announcedTotal', 'groundTruthTotal',
  'noteCountDetected', 'noteCountTrue', 'latencyMs', 'offlineVoiceOk',
] as const;
export type LogColumn = (typeof REQUIRED_COLUMNS)[number];

/** Lỗi định dạng nhật ký; line là số dòng trong file (bắt đầu từ 1) hoặc null khi lỗi ở mức cả file. */
export class LogFormatError extends Error {
  readonly line: number | null;
  constructor(message: string, line: number | null = null) {
    super(line === null ? message : `Dòng ${line}: ${message}`);
    this.name = 'LogFormatError';
    this.line = line;
  }
}

/** Một lượt thử đã kiểm tra hợp lệ. null = ô trống (không đo). */
export interface LogRow {
  line: number;
  timestamp: string;
  scenarioId: string;
  state: string;
  status: string;
  /** Tổng app đã đọc; null = app không đọc tổng (từ chối hoặc im lặng). */
  announcedTotal: number | null;
  /** Tổng thật; luôn có (0 khi không có tiền). */
  groundTruthTotal: number;
  noteCountDetected: number | null;
  /** Số tờ thật; luôn có (0 khi không có tiền). */
  noteCountTrue: number;
  latencyMs: number | null;
  offlineVoiceOk: boolean | null;
}

const BOM = 0xfeff;
const TRUE_WORDS = new Set(['true', '1', 'yes']);
const FALSE_WORDS = new Set(['false', '0', 'no']);

/** Tách CSV theo RFC 4180 rút gọn: dấu phẩy, ngoặc kép (nhân đôi để thoát), xuống dòng CRLF hoặc LF. Trả về từng bản ghi kèm dòng bắt đầu. */
export function splitCsv(text: string): Array<{ line: number; fields: string[] }> {
  const body = text.charCodeAt(0) === BOM ? text.slice(1) : text;
  const records: Array<{ line: number; fields: string[] }> = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endRecord = (): void => {
    fields.push(field);
    if (fields.length > 1 || (fields[0] ?? '').trim() !== '') records.push({ line: startLine, fields });
    fields = [];
    field = '';
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    if (quoted) {
      if (ch === '"' && body.charAt(i + 1) === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else { field += ch; if (ch === '\n') line++; }
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { fields.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body.charAt(i + 1) === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else field += ch;
  }
  if (quoted) throw new LogFormatError('ngoặc kép mở nhưng không đóng', startLine);
  if (field !== '' || fields.length > 0) endRecord();
  return records;
}

function cell(row: readonly string[], index: Map<LogColumn, number>, column: LogColumn): string {
  const i = index.get(column);
  return i === undefined ? '' : (row[i] ?? '').trim();
}

function parseNumber(raw: string, column: LogColumn, line: number, integer: boolean): number | null {
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    const kind = integer ? 'số nguyên không âm' : 'số không âm';
    throw new LogFormatError(`cột ${column} = "${raw}" không phải ${kind}`, line);
  }
  return value;
}

function parseBoolean(raw: string, line: number): boolean | null {
  if (raw === '') return null;
  const word = raw.toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  throw new LogFormatError(`cột offlineVoiceOk = "${raw}" phải là true/false (hoặc 1/0, yes/no) hoặc để trống`, line);
}

/** Bảo đảm cột bắt buộc không trống: các cột này là sự thật do người thử nghiệm ghi, thiếu thì số liệu vô nghĩa. */
function required<T>(value: T | null, column: LogColumn, line: number): T {
  if (value === null) throw new LogFormatError(`cột ${column} bắt buộc phải có giá trị (đặt 0 khi không có tiền)`, line);
  return value;
}

/**
 * Đọc nhật ký. Ném LogFormatError khi: file rỗng; thiếu cột bắt buộc; dòng có số ô khác tiêu đề;
 * số không hợp lệ; scenarioId trống; groundTruthTotal / noteCountTrue trống; hai cột sự thật mâu thuẫn
 * (noteCountTrue = 0 mà groundTruthTotal > 0, hoặc ngược lại).
 */
export function parseLog(text: string): LogRow[] {
  const records = splitCsv(text);
  const header = records[0];
  if (header === undefined) throw new LogFormatError('nhật ký rỗng (không có dòng tiêu đề)');
  const names = header.fields.map((f) => f.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !names.includes(c));
  if (missing.length > 0) {
    throw new LogFormatError(`thiếu cột bắt buộc: ${missing.join(', ')}. Các cột đang có: ${names.join(', ')}`, header.line);
  }
  const index = new Map<LogColumn, number>(REQUIRED_COLUMNS.map((c) => [c, names.indexOf(c)]));

  return records.slice(1).map(({ line, fields }) => {
    if (fields.length !== names.length) {
      throw new LogFormatError(`có ${fields.length} ô nhưng tiêu đề có ${names.length} cột`, line);
    }
    const scenarioId = cell(fields, index, 'scenarioId');
    if (scenarioId === '') throw new LogFormatError('cột scenarioId bắt buộc phải có giá trị', line);
    const groundTruthTotal = required(parseNumber(cell(fields, index, 'groundTruthTotal'), 'groundTruthTotal', line, true), 'groundTruthTotal', line);
    const noteCountTrue = required(parseNumber(cell(fields, index, 'noteCountTrue'), 'noteCountTrue', line, true), 'noteCountTrue', line);
    if ((noteCountTrue === 0) !== (groundTruthTotal === 0)) {
      throw new LogFormatError(`noteCountTrue = ${noteCountTrue} mâu thuẫn với groundTruthTotal = ${groundTruthTotal}`, line);
    }
    return {
      line,
      timestamp: cell(fields, index, 'timestamp'),
      scenarioId,
      state: cell(fields, index, 'state'),
      status: cell(fields, index, 'status'),
      announcedTotal: parseNumber(cell(fields, index, 'announcedTotal'), 'announcedTotal', line, true),
      groundTruthTotal,
      noteCountDetected: parseNumber(cell(fields, index, 'noteCountDetected'), 'noteCountDetected', line, true),
      noteCountTrue,
      latencyMs: parseNumber(cell(fields, index, 'latencyMs'), 'latencyMs', line, false),
      offlineVoiceOk: parseBoolean(cell(fields, index, 'offlineVoiceOk'), line),
    };
  });
}