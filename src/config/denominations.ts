import { AppError, DENOMINATIONS } from '../contracts';
import type { ClassesJson, Denomination } from '../contracts';

/**
 * Định dạng số tiền theo kiểu Việt Nam, ví dụ 170000 → "170.000 đồng".
 * Tự ghép dấu chấm (không dùng toLocaleString vì phụ thuộc ICU của thiết bị).
 * Số không hữu hạn hoặc vượt số nguyên an toàn thì ném RangeError: thà lỗi còn hơn đọc sai số tiền.
 */
export function formatVND(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`formatVND: số tiền không hợp lệ (${String(n)})`);
  }
  const rounded = Math.round(n);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  let grouped = '';
  for (let end = digits.length; end > 0; end -= 3) {
    const chunk = digits.slice(Math.max(0, end - 3), end);
    grouped = grouped === '' ? chunk : `${chunk}.${grouped}`;
  }
  return `${sign}${grouped} đồng`;
}

/** Kiểm tra n có thuộc 9 mệnh giá hợp lệ không. */
export function isDenomination(n: number): n is Denomination {
  return (DENOMINATIONS as readonly number[]).includes(n);
}

function corrupt(message: string): AppError {
  return new AppError('MODEL_CORRUPT', `classes.json không hợp lệ: ${message}`, true);
}

/**
 * Dựng bảng tra classId → mệnh giá từ classes.json. KHÔNG giả định thứ tự ID:
 * kết quả được đặt theo đúng classId ghi trong file.
 * Ném AppError MODEL_CORRUPT nếu không đủ 9 lớp, classId không phải số nguyên 0..8,
 * giá trị ngoài danh sách mệnh giá, hoặc có mệnh giá trùng.
 */
export function buildClassMap(c: ClassesJson): Denomination[] {
  const entries = Object.entries(c);
  if (entries.length !== DENOMINATIONS.length) {
    throw corrupt(`cần đúng ${DENOMINATIONS.length} lớp, nhận được ${entries.length}`);
  }

  const map: Denomination[] = [];
  const seen = new Set<number>();
  for (const [key, raw] of entries) {
    if (!/^(0|[1-9]\d*)$/.test(key)) {
      throw corrupt(`classId "${key}" không phải số nguyên không âm`);
    }
    const id = Number(key);
    if (id >= DENOMINATIONS.length) {
      throw corrupt(`classId ${id} vượt phạm vi 0..${DENOMINATIONS.length - 1}`);
    }
    const value: unknown = raw;
    if (typeof value !== 'number' || !isDenomination(value)) {
      throw corrupt(`classId ${id} có giá trị ${String(value)} không thuộc danh sách mệnh giá`);
    }
    if (seen.has(value)) {
      throw corrupt(`mệnh giá ${value} bị trùng`);
    }
    seen.add(value);
    map[id] = value;
  }
  // Đủ 9 khoá phân biệt trong 0..8 nên mảng kết quả không thể có lỗ hổng.
  return map;
}