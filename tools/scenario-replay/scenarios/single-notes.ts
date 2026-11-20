// Kịch bản một tờ tiền: chín mệnh giá ổn định, cộng hai ca có nhiễu (độ tin cậy, vị trí, khung rơi, khung mờ, khung tối).
import { DENOMINATIONS } from '../../../src/contracts';
import type { Denomination } from '../../../src/contracts';
import { formatVND } from '../../../src/config/denominations';
import type { Scenario } from '../scenario';
import { CONF_STABLE, STABLE_FRAMES, phaseOf, singleNote } from './shared';

/** Độ tin cậy chuẩn của ca nhiễu; cách confSure (0,7) trên 4 độ lệch chuẩn để nhiễu hiếm khi kéo xuống "chưa chắc". */
const NOISY_CONFIDENCE = 0.88;
const NOISY_CONFIDENCE_SIGMA = 0.04;
/** Nhiễu vị trí (pixel) và tỷ lệ khung rơi của ca nhiễu. */
const NOISY_POSITION_SIGMA_PX = 3;
const NOISY_DROP_RATE = 0.2;
/** Tỷ lệ khung mờ và khung tối trong ca chất lượng ảnh kém. */
const DEGRADED_BLUR_RATE = 0.15;
const DEGRADED_DARK_RATE = 0.15;

const stableSingle = (denomination: Denomination): Scenario => ({
  id: `single-${denomination}`,
  name: `Một tờ ${formatVND(denomination)} đặt ổn định`,
  groundTruth: [denomination],
  expectation: 'PUBLISH',
  generation: { phases: [phaseOf(STABLE_FRAMES, [singleNote(denomination, CONF_STABLE)])] },
  knownLimitation: false,
  notes: 'Một tờ, độ tin cậy cao, không nhiễu. Kỳ vọng: đọc đúng đúng một lần rồi im lặng.',
});

/** Chín kịch bản, mỗi mệnh giá một ca, theo thứ tự trong DENOMINATIONS. */
export const STABLE_SINGLE_SCENARIOS: readonly Scenario[] = DENOMINATIONS.map(stableSingle);

export const NOISY_SINGLE_SCENARIO: Scenario = {
  id: 'single-20000-noisy',
  name: 'Một tờ 20.000 đồng, có nhiễu và rơi khung',
  groundTruth: [20000],
  expectation: 'PUBLISH',
  generation: {
    phases: [phaseOf(STABLE_FRAMES, [singleNote(20000, NOISY_CONFIDENCE)])],
    noise: { confidenceSigma: NOISY_CONFIDENCE_SIGMA, positionSigmaPx: NOISY_POSITION_SIGMA_PX, dropRate: NOISY_DROP_RATE },
  },
  knownLimitation: false,
  notes: 'Nhiễu độ tin cậy, nhiễu vị trí và 20% khung rơi. Kỳ vọng: vẫn đọc đúng, không đọc lặp.',
};

export const DEGRADED_SINGLE_SCENARIO: Scenario = {
  id: 'single-50000-blur-dark',
  name: 'Một tờ 50.000 đồng, xen khung mờ và khung tối',
  groundTruth: [50000],
  expectation: 'PUBLISH',
  generation: {
    phases: [phaseOf(STABLE_FRAMES, [singleNote(50000, CONF_STABLE)])],
    noise: { blurRate: DEGRADED_BLUR_RATE, darkRate: DEGRADED_DARK_RATE },
  },
  knownLimitation: false,
  notes: 'Mặc định blockOnBlur và blockOnLowLight tắt nên khung mờ/tối không chặn đọc khi mô hình vẫn chắc. Kỳ vọng: đọc đúng.',
};