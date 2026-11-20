// Kịch bản nhiều tờ: đặt xa nhau (đọc được), chồng nhau và xung đột lớp (phải từ chối), và ca BỎ SÓT TỜ (hạn chế đã biết).
import type { Scenario } from '../scenario';
import {
  CONF_STABLE, CONF_VERY_SURE, OVERLAP_BOXES, SINGLE_BOX, STABLE_FRAMES, THREE_FAR_BOXES, TWO_FAR_BOXES, phaseOf,
} from './shared';

/** Độ tin cậy của tờ thứ hai trong ca xung đột lớp (tờ thứ nhất dùng CONF_CONFLICT_FIRST). */
const CONF_CONFLICT_FIRST = 0.85;
const CONF_CONFLICT_SECOND = 0.8;

export const TWO_FAR_SCENARIO: Scenario = {
  id: 'two-notes-far',
  name: 'Hai tờ 10.000 và 50.000 đặt xa nhau',
  groundTruth: [10000, 50000],
  expectation: 'PUBLISH',
  generation: {
    phases: [phaseOf(STABLE_FRAMES, [
      { denomination: 10000, box: TWO_FAR_BOXES[0], confidence: CONF_STABLE },
      { denomination: 50000, box: TWO_FAR_BOXES[1], confidence: CONF_STABLE },
    ])],
  },
  knownLimitation: false,
  notes: 'Hai tờ không chồng nhau. Kỳ vọng: đọc tổng 60.000 đồng đúng một lần.',
};

export const THREE_FAR_SCENARIO: Scenario = {
  id: 'three-notes-far',
  name: 'Ba tờ 5.000, 20.000 và 100.000 đặt xa nhau',
  groundTruth: [5000, 20000, 100000],
  expectation: 'PUBLISH',
  generation: {
    phases: [phaseOf(STABLE_FRAMES, [
      { denomination: 5000, box: THREE_FAR_BOXES[0], confidence: CONF_STABLE },
      { denomination: 20000, box: THREE_FAR_BOXES[1], confidence: CONF_STABLE },
      { denomination: 100000, box: THREE_FAR_BOXES[2], confidence: CONF_STABLE },
    ])],
  },
  knownLimitation: false,
  notes: 'Ba tờ không chồng nhau. Kỳ vọng: đọc tổng 125.000 đồng đúng một lần.',
};

export const OVERLAPPING_SCENARIO: Scenario = {
  id: 'two-notes-overlapping',
  name: 'Hai tờ 20.000 và 50.000 chồng lên nhau',
  groundTruth: [20000, 50000],
  expectation: 'REJECT',
  generation: {
    phases: [phaseOf(STABLE_FRAMES, [
      { denomination: 20000, box: OVERLAP_BOXES[0], confidence: CONF_STABLE },
      { denomination: 50000, box: OVERLAP_BOXES[1], confidence: CONF_STABLE },
    ])],
  },
  knownLimitation: false,
  notes: 'Hộp chồng nhau quá ngưỡng overlapRatio. Kỳ vọng: không đọc tổng, chỉ hướng dẫn tách tiền ra.',
};

export const CLASS_CONFLICT_SCENARIO: Scenario = {
  id: 'class-conflict',
  name: 'Một tờ mô hình phân vân giữa 20.000 và 50.000',
  groundTruth: [20000],
  expectation: 'REJECT',
  generation: {
    phases: [phaseOf(STABLE_FRAMES, [
      { denomination: 20000, box: SINGLE_BOX, confidence: CONF_CONFLICT_FIRST },
      { denomination: 50000, box: SINGLE_BOX, confidence: CONF_CONFLICT_SECOND },
    ])],
  },
  knownLimitation: false,
  notes: 'Hai hộp cùng vị trí khác mệnh giá, cả hai đều chắc. Kỳ vọng: không đọc, báo xung đột.',
};

/**
 * HẠN CHẾ ĐÃ BIẾT. Sự thật có ba tờ nhưng mô hình chỉ thấy hai tờ với độ tin cậy 0,95.
 * Không có tín hiệu nào trong khung cho thấy còn một tờ bị sót, nên hệ thống sẽ đọc 25.000 thay vì 125.000.
 * Kịch bản này được tính RIÊNG, không được giấu và không làm hỏng chỉ số Unsafe Read Rate chính.
 */
export const THREE_SEEN_AS_TWO_SCENARIO: Scenario = {
  id: 'three-notes-seen-as-two',
  name: 'Ba tờ nhưng mô hình chỉ thấy hai (bỏ sót tờ)',
  groundTruth: [5000, 20000, 100000],
  expectation: 'PUBLISH',
  generation: {
    phases: [phaseOf(STABLE_FRAMES, [
      { denomination: 5000, box: THREE_FAR_BOXES[0], confidence: CONF_VERY_SURE },
      { denomination: 20000, box: THREE_FAR_BOXES[1], confidence: CONF_VERY_SURE },
    ])],
  },
  knownLimitation: true,
  notes: 'Tờ 100.000 bị mô hình bỏ sót hoàn toàn. Hệ thống đọc sai (25.000 thay vì 125.000). Chỉ giảm được bằng mô hình tốt hơn hoặc hướng dẫn người dùng đặt từng tờ.',
};