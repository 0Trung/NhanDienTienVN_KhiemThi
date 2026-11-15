import type { Denomination } from '../contracts';

/** Số lớn nhất đọc được: 999.999.999.999 (chín trăm chín mươi chín tỷ ...). */
export const MAX_SPEAKABLE_NUMBER = 999_999_999_999;

const DIGIT_WORDS: readonly string[] = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

/** Tên từng nhóm ba chữ số, từ thấp lên cao: (đơn vị), nghìn, triệu, tỷ. Dùng "nghìn", không dùng "ngàn". */
const GROUP_WORDS: readonly string[] = ['', 'nghìn', 'triệu', 'tỷ'];

function digitWord(d: number): string {
  const word = DIGIT_WORDS[d];
  if (word === undefined) throw new RangeError(`Chữ số không hợp lệ: ${String(d)}`);
  return word;
}

/** Hàng đơn vị đứng sau hàng chục từ "mười" trở lên: lăm (từ 15), mốt và tư (từ 21, 24). */
function unitsAfterTens(tens: number, units: number): string {
  if (units === 5) return 'lăm';
  if (tens >= 2 && units === 1) return 'mốt';
  if (tens >= 2 && units === 4) return 'tư';
  return digitWord(units);
}

/**
 * Đọc một nhóm ba chữ số (1..999).
 * hasHigherGroup = true khi đã đọc một nhóm lớn hơn: lúc đó hàng trăm bằng 0 vẫn đọc "không trăm".
 * Có hàng trăm (hoặc "không trăm") mà hàng chục bằng 0, hàng đơn vị khác 0 thì đọc "linh".
 */
function readGroup(value: number, hasHigherGroup: boolean): string {
  if (value === 0) return '';
  const hundreds = Math.floor(value / 100);
  const tens = Math.floor((value % 100) / 10);
  const units = value % 10;
  const sayHundreds = hundreds > 0 || hasHigherGroup;
  const words: string[] = [];

  if (sayHundreds) words.push(digitWord(hundreds), 'trăm');
  if (tens === 0) {
    if (units > 0) {
      if (sayHundreds) words.push('linh');
      words.push(digitWord(units));
    }
  } else if (tens === 1) {
    words.push('mười');
    if (units > 0) words.push(unitsAfterTens(tens, units));
  } else {
    words.push(digitWord(tens), 'mươi');
    if (units > 0) words.push(unitsAfterTens(tens, units));
  }
  return words.join(' ');
}

/**
 * Đọc số nguyên 0..999.999.999.999 thành chữ tiếng Việt, ví dụ 105000 → "một trăm linh năm nghìn".
 * Số âm, số thập phân, NaN, vô cực hoặc vượt giới hạn thì ném RangeError:
 * thà không đọc còn hơn đọc sai số tiền.
 */
export function numberToVietnameseWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_SPEAKABLE_NUMBER) {
    throw new RangeError(
      `numberToVietnameseWords: cần số nguyên từ 0 đến ${MAX_SPEAKABLE_NUMBER}, nhận được ${String(n)}`,
    );
  }
  if (n === 0) return digitWord(0);

  // groups[0] là nhóm đơn vị, groups[1] là nghìn, groups[2] là triệu, groups[3] là tỷ.
  const groups: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) groups.push(rest % 1000);

  const words: string[] = [];
  let spokeHigherGroup = false;
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const value = groups[g];
    if (value === undefined || value === 0) continue;
    words.push(readGroup(value, spokeHigherGroup));
    const unit = GROUP_WORDS[g];
    if (unit !== undefined && unit !== '') words.push(unit);
    spokeHigherGroup = true;
  }
  return words.join(' ');
}

/** Đọc số tiền: thêm chữ "đồng" ở cuối, ví dụ 170000 → "một trăm bảy mươi nghìn đồng". */
export function moneyToSpeech(n: number): string {
  return `${numberToVietnameseWords(n)} đồng`;
}

/** Đọc một mệnh giá, ví dụ 50000 → "năm mươi nghìn đồng". */
export function denominationToSpeech(d: Denomination): string {
  return moneyToSpeech(d);
}