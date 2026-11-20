// Kịch bản khó: chưa chắc, vật giống tiền, tiền chập chờn, thay tờ tại chỗ, rút ra rồi đưa lại.
import type { Scenario } from '../scenario';
import { CONF_STABLE, CONF_UNSURE, STABLE_FRAMES, phaseOf, singleNote } from './shared';

/** Hai mức độ tin cậy luân phiên của vật giống tiền: một mức dưới confSure (0,7), một mức trên. */
const LOOKALIKE_CONFIDENCES: readonly number[] = [0.75, 0.4];
/** Nhiễu độ tin cậy nhẹ của ca vật giống tiền và ca độ tin cậy thấp. */
const LIGHT_CONFIDENCE_SIGMA = 0.03;
/** Số khung của các pha ngắn trong ca chập chờn: tờ có mặt (6, 4, 3, 8) và khoảng trống (2, 5, 3). Khoảng trống dài nhất = 5, sát dưới emptyFramesToReset (6). */
const FLICKER_PRESENT = [6, 4, 3, 8] as const;
const FLICKER_GAPS = [2, 5, 3] as const;
/** Số khung mỗi tờ trong ca thay tờ tại chỗ, và độ dài các đoạn trong ca rút ra đưa lại (khoảng trống 8 ≥ emptyFramesToReset). */
const REPLACED_FIRST_FRAMES = 12;
const REPLACED_SECOND_FRAMES = 14;
const RETURN_PRESENT_BEFORE = 8;
const RETURN_GAP = 8;
const RETURN_PRESENT_AFTER = 10;

export const LOW_CONFIDENCE_SCENARIO: Scenario = {
  id: 'single-low-confidence',
  name: 'Một tờ 20.000 nhưng độ tin cậy chỉ 0,55',
  groundTruth: [20000],
  expectation: 'REJECT',
  generation: {
    phases: [phaseOf(STABLE_FRAMES, [singleNote(20000, CONF_UNSURE)])],
    noise: { confidenceSigma: LIGHT_CONFIDENCE_SIGMA },
  },
  knownLimitation: false,
  notes: 'Fail Safe: mô hình chưa chắc thì không đọc tổng dù tờ tiền thật là 20.000. Kỳ vọng: từ chối, hướng dẫn đưa tiền rõ hơn.',
};

export const LOOKALIKE_SCENARIO: Scenario = {
  id: 'no-money-lookalike',
  name: 'Không có tiền, chỉ có vật giống tiền (độ tin cậy dao động 0,4 / 0,75)',
  groundTruth: null,
  expectation: 'REJECT',
  generation: {
    phases: [phaseOf(STABLE_FRAMES, [singleNote(20000, LOOKALIKE_CONFIDENCES)])],
    noise: { confidenceSigma: LIGHT_CONFIDENCE_SIGMA },
  },
  knownLimitation: false,
  notes: 'Vật giống tiền làm mô hình dao động quanh ngưỡng. Kỳ vọng: không bao giờ đọc (đọc là dương tính giả).',
};

const flickerPhases = FLICKER_PRESENT.flatMap((present, i) => {
  const note = phaseOf(present, [singleNote(20000, CONF_STABLE)]);
  const gap = FLICKER_GAPS[i];
  return gap === undefined ? [note] : [note, phaseOf(gap, [])];
});

export const FLICKER_SCENARIO: Scenario = {
  id: 'money-flicker',
  name: 'Tờ 20.000 chập chờn ra vào khung',
  groundTruth: [20000],
  expectation: 'PUBLISH',
  generation: { phases: flickerPhases },
  knownLimitation: false,
  notes: 'Tờ tiền chưa hề rời tay người dùng (khoảng trống ngắn hơn emptyFramesToReset). Kỳ vọng: đọc đúng một lần, không đọc lặp.',
};

export const REPLACED_SCENARIO: Scenario = {
  id: 'note-replaced-in-place',
  name: 'Đổi từ tờ 20.000 sang 50.000 mà tiền vẫn trong khung',
  groundTruth: [50000],
  expectation: 'PUBLISH',
  generation: {
    phases: [
      phaseOf(REPLACED_FIRST_FRAMES, [singleNote(20000, CONF_STABLE)], [20000]),
      phaseOf(REPLACED_SECOND_FRAMES, [singleNote(50000, CONF_STABLE)]),
    ],
  },
  knownLimitation: false,
  notes: 'Không có khung trống giữa hai tờ. Kỳ vọng: đọc 20.000 rồi đọc 50.000 (tập mới khác chữ ký cũ), mỗi tập đúng một lần.',
};

export const LEAVES_AND_RETURNS_SCENARIO: Scenario = {
  id: 'single-leaves-and-returns',
  name: 'Tờ 20.000 rút ra khỏi khung rồi đưa lại',
  groundTruth: [20000],
  expectation: 'PUBLISH',
  generation: {
    phases: [
      phaseOf(RETURN_PRESENT_BEFORE, [singleNote(20000, CONF_STABLE)]),
      phaseOf(RETURN_GAP, []),
      phaseOf(RETURN_PRESENT_AFTER, [singleNote(20000, CONF_STABLE)]),
    ],
  },
  knownLimitation: false,
  notes: 'Khoảng trống đủ dài để xoá chữ ký đã đọc. Kỳ vọng: đọc hai lần và cả hai đều hợp lệ (không tính là đọc lặp).',
};