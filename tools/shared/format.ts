// Tiện ích dùng chung cho hai công cụ đo: định dạng số kiểu Việt Nam, bảng markdown, phân vị. Hàm thuần, không chạm fs/DOM.

/** Đổi tỷ lệ 0..1 sang phần trăm. */
const PERCENT = 100;
/** Số chữ số thập phân khi in phần trăm. */
const PERCENT_DIGITS = 1;
/** Số chữ số thập phân khi in số đo thời gian (mili-giây). */
const MS_DIGITS = 0;
/** Chữ in ra khi không có dữ liệu để tính. */
export const NOT_AVAILABLE = 'N/A';

/** Một tỷ lệ kèm tử số và mẫu số, để báo cáo luôn cho thấy "bao nhiêu trên bao nhiêu". */
export interface Rate {
  numerator: number;
  denominator: number;
  /** numerator / denominator trong [0, 1]; null khi mẫu số = 0 (không đo được). */
  value: number | null;
}

/** Dựng Rate; mẫu số 0 cho value = null thay vì NaN. */
export function makeRate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

/** Số thập phân kiểu Việt Nam (dấu phẩy). */
export function formatDecimal(value: number, digits: number): string {
  return value.toFixed(digits).replace('.', ',');
}

/** "97,5% (39/40)"; không đo được thì "N/A (0/0)". */
export function formatRate(rate: Rate): string {
  const counts = `${rate.numerator}/${rate.denominator}`;
  if (rate.value === null) return `${NOT_AVAILABLE} (${counts})`;
  return `${formatDecimal(rate.value * PERCENT, PERCENT_DIGITS)}% (${counts})`;
}

/** Số đo thời gian kèm đơn vị; null thì "N/A". */
export function formatMs(value: number | null): string {
  return value === null ? NOT_AVAILABLE : `${formatDecimal(value, MS_DIGITS)} ms`;
}

/** Số thập phân hoặc "N/A". */
export function formatOptional(value: number | null, digits: number): string {
  return value === null ? NOT_AVAILABLE : formatDecimal(value, digits);
}

/**
 * Phân vị theo phương pháp hạng gần nhất (nearest-rank): hạng = ceil(p/100 × n).
 * Mảng rỗng trả null. Ném RangeError nếu p ngoài [0, 100]. Không sửa mảng đầu vào.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(p >= 0 && p <= PERCENT)) throw new RangeError(`percentile: p phải thuộc [0, ${PERCENT}], nhận ${String(p)}`);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / PERCENT) * sorted.length));
  return sorted[rank - 1] ?? null;
}

/** Trung bình cộng; mảng rỗng trả null (khác mean của src/utils/math, vốn trả 0). */
export function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

const escapeCell = (cell: string): string => cell.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Bảng markdown. Mỗi hàng phải có đúng bằng số cột của tiêu đề, nếu không ném RangeError. */
export function renderTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const line = (cells: readonly string[]): string => `| ${cells.map(escapeCell).join(' | ')} |`;
  for (const row of rows) {
    if (row.length !== headers.length) {
      throw new RangeError(`renderTable: hàng có ${row.length} ô, tiêu đề có ${headers.length} cột`);
    }
  }
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}