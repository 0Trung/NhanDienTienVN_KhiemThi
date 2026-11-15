import type { Denomination } from '../contracts';
import { formatVND, isDenomination } from '../config/denominations';

/** Kết quả tính tổng một tập tờ tiền đã được xác nhận. */
export interface TotalCalculation {
  count: number;
  denominations: Denomination[];
  total: number;
  formattedTotal: string;
}

/**
 * Tính tổng các tờ tiền đã được xác nhận (Module 7).
 * - `denominations` trả về là BẢN SAO, giữ nguyên thứ tự đầu vào (trái → phải); không sửa mảng đầu vào.
 * - Danh sách rỗng hoặc có giá trị ngoài 9 mệnh giá hợp lệ thì ném RangeError:
 *   thà dừng còn hơn đọc sai số tiền (Fail Safe).
 * - CHỈ DecisionEngine được gọi hàm này, và chỉ ở nhánh công bố kết quả.
 */
export function calculateTotal(d: Denomination[]): TotalCalculation {
  if (d.length === 0) {
    throw new RangeError('calculateTotal: danh sách mệnh giá rỗng');
  }
  let total = 0;
  for (const value of d) {
    if (!isDenomination(value)) {
      throw new RangeError(`calculateTotal: giá trị ngoài danh sách mệnh giá (${String(value)})`);
    }
    total += value;
  }
  return { count: d.length, denominations: [...d], total, formattedTotal: formatVND(total) };
}