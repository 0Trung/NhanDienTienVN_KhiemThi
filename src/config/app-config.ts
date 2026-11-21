import type { AppConfig, Settings } from '../contracts';

/** Mọi ngưỡng ở đây là điểm xuất phát để thử nghiệm, chưa phải giá trị đã được chứng minh. */
export const DEFAULT_CONFIG: AppConfig = {
  inference: { confLow: 0.25, confSure: 0.7, nmsIou: 0.45, agnosticNms: true, maxDetections: 20, targetFps: 5, preferWebGpu: false, verifyChecksum: true },
  analyzer: {
    grayThumbWidth: 256, overlapRatio: 0.25, conflictIou: 0.5, minAreaRatio: 0.04, edgeMarginRatio: 0.05,
    blurThreshold: 60,   // phương sai Laplacian: PHẢI hiệu chỉnh trên điện thoại thật
    lowLightMean: 60,    // độ sáng trung bình 0..255
    stabilizer: { windowSize: 5, minAgree: 4, matchIou: 0.5, maxAgeMs: 2500 },
  },
  decision: {
    multiNotePolicy: 'MULTI', blockOnPartial: true, blockOnBlur: false, blockOnLowLight: false,
    emptyFramesToReset: 6, noMoneyGuidanceDelayMs: 4000, unstableGuidanceMs: 5000, guidanceCooldownMs: 6000,
    guidancePriority: ['CLASS_CONFLICT', 'OVERLAP', 'PARTIAL_IN_FRAME', 'TOO_FAR', 'LOW_LIGHT', 'BLUR', 'LOW_CONFIDENCE', 'MULTI_NOT_ALLOWED', 'HOLD_STEADY', 'NO_MONEY'],
  },
  speech: { dedupeWindowMs: 5000, minGapMs: 400, guidanceStaleMs: 3000, maxUtteranceMs: 15000 },
  settings: { fontScaleMin: 1, fontScaleMax: 2, speechRates: [0.8, 1.0, 1.2], modelVersionMaxLength: 32 },
};

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1, voiceEnabled: true, voiceLanguage: 'vi-VN', speechRate: 1.0, verbosity: 'DETAILED',
  speechOutput: 'APP_TTS', vibrationEnabled: true, torchEnabled: false, fontScale: 1,
  highContrast: false, autoStartCamera: true, modelVersion: '1.0.0',
};