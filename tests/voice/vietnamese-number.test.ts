import { describe, expect, it } from 'vitest';
import { DENOMINATIONS } from '../../src/contracts';
import type { Denomination } from '../../src/contracts';
import {
  denominationToSpeech,
  MAX_SPEAKABLE_NUMBER,
  moneyToSpeech,
  numberToVietnameseWords,
} from '../../src/voice/vietnamese-number';

describe('numberToVietnameseWords: các số theo yêu cầu nghiệm thu', () => {
  it.each([
    [1000, 'một nghìn'], [2000, 'hai nghìn'], [5000, 'năm nghìn'], [10000, 'mười nghìn'],
    [15000, 'mười lăm nghìn'], [20000, 'hai mươi nghìn'], [21000, 'hai mươi mốt nghìn'],
    [25000, 'hai mươi lăm nghìn'], [50000, 'năm mươi nghìn'], [100000, 'một trăm nghìn'],
    [105000, 'một trăm linh năm nghìn'], [170000, 'một trăm bảy mươi nghìn'], [200000, 'hai trăm nghìn'],
    [500000, 'năm trăm nghìn'], [1005000, 'một triệu không trăm linh năm nghìn'],
    [1250000, 'một triệu hai trăm năm mươi nghìn'], [2000000, 'hai triệu'],
  ])('%d → %s', (n, words) => {
    expect(numberToVietnameseWords(n)).toBe(words);
  });
});

describe('numberToVietnameseWords: mười, mươi, lăm, mốt, tư', () => {
  it.each([
    [0, 'không'], [1, 'một'], [4, 'bốn'], [5, 'năm'], [10, 'mười'], [11, 'mười một'], [14, 'mười bốn'],
    [15, 'mười lăm'], [20, 'hai mươi'], [21, 'hai mươi mốt'], [24, 'hai mươi tư'], [25, 'hai mươi lăm'],
    [34, 'ba mươi tư'], [55, 'năm mươi lăm'], [99, 'chín mươi chín'],
  ])('%d → %s', (n, words) => {
    expect(numberToVietnameseWords(n)).toBe(words);
  });
});

describe('numberToVietnameseWords: linh, không trăm, đơn vị nhóm', () => {
  it.each([
    [101, 'một trăm linh một'], [105, 'một trăm linh năm'], [110, 'một trăm mười'], [115, 'một trăm mười lăm'],
    [1001, 'một nghìn không trăm linh một'], [1010, 'một nghìn không trăm mười'], [1100, 'một nghìn một trăm'],
    [1000005, 'một triệu không trăm linh năm'], [1001000, 'một triệu không trăm linh một nghìn'],
    [1000000000, 'một tỷ'], [21000000005, 'hai mươi mốt tỷ không trăm linh năm'],
    [
      MAX_SPEAKABLE_NUMBER,
      'chín trăm chín mươi chín tỷ chín trăm chín mươi chín triệu chín trăm chín mươi chín nghìn chín trăm chín mươi chín',
    ],
  ])('%d → %s', (n, words) => {
    expect(numberToVietnameseWords(n)).toBe(words);
  });

  it('dùng "nghìn", không bao giờ dùng "ngàn"', () => {
    expect(numberToVietnameseWords(1234567)).not.toContain('ngàn');
  });
});

describe('numberToVietnameseWords: đầu vào không hợp lệ ném RangeError', () => {
  it.each([
    ['số âm', -1], ['số thập phân', 1.5], ['NaN', Number.NaN], ['vô cực', Number.POSITIVE_INFINITY],
    ['vượt giới hạn', MAX_SPEAKABLE_NUMBER + 1], ['vượt số nguyên an toàn', Number.MAX_SAFE_INTEGER + 1],
  ])('%s', (_label, n) => {
    expect(() => numberToVietnameseWords(n)).toThrow(RangeError);
  });
});

describe('moneyToSpeech và denominationToSpeech', () => {
  it.each([
    [0, 'không đồng'], [170000, 'một trăm bảy mươi nghìn đồng'], [1005000, 'một triệu không trăm linh năm nghìn đồng'],
  ])('moneyToSpeech(%d) → %s', (n, speech) => {
    expect(moneyToSpeech(n)).toBe(speech);
  });

  it('moneyToSpeech ném RangeError với số không hợp lệ', () => {
    expect(() => moneyToSpeech(-1000)).toThrow(RangeError);
  });

  const expected: Record<Denomination, string> = {
    1000: 'một nghìn đồng', 2000: 'hai nghìn đồng', 5000: 'năm nghìn đồng', 10000: 'mười nghìn đồng',
    20000: 'hai mươi nghìn đồng', 50000: 'năm mươi nghìn đồng', 100000: 'một trăm nghìn đồng',
    200000: 'hai trăm nghìn đồng', 500000: 'năm trăm nghìn đồng',
  };
  it.each(DENOMINATIONS.map((d): [Denomination, string] => [d, expected[d]]))('denominationToSpeech(%d) → %s', (d, speech) => {
    expect(denominationToSpeech(d)).toBe(speech);
  });
});