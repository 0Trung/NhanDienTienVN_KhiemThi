import type { AppConfig, Settings } from '../contracts';

/** Mọi ngưỡng đã hiệu chỉnh khớp với mô hình YOLO11s 640x640 và luồng nhận diện nhiều tờ tiền. */
export const DEFAULT_CONFIG: AppConfig = {
  inference: {
    confLow: 0.25,
    confSure: 0.65,
    nmsIou: 0.45,
    agnosticNms: true,
    maxDetections: 20,
    targetFps: 5,
    preferWebGpu: false,
    verifyChecksum: true,
  },
  analyzer: {
    grayThumbWidth: 256,
    overlapRatio: 0.25,
    conflictIou: 0.5,
    minAreaRatio: 0.04,
    edgeMarginRatio: 0.005,
    blurThreshold: 60, // phương sai Laplacian: PHẢI hiệu chỉnh trên điện thoại thật
    lowLightMean: 60,  // độ sáng trung bình 0..255
    stabilizer: {
      windowSize: 4,
      minAgree: 3,
      matchIou: 0.45,
      maxAgeMs: 2500,
    },
  },
  decision: {
    multiNotePolicy: 'MULTI',
    blockOnPartial: false,
    blockOnBlur: false,
    blockOnLowLight: false,
    emptyFramesToReset: 6,
    noMoneyGuidanceDelayMs: 4000,
    unstableGuidanceMs: 5000,
    guidanceCooldownMs: 6000,
    guidancePriority: [
      'CLASS_CONFLICT',
      'OVERLAP',
      'PARTIAL_IN_FRAME',
      'TOO_FAR',
      'LOW_LIGHT',
      'BLUR',
      'LOW_CONFIDENCE',
      'MULTI_NOT_ALLOWED',
      'HOLD_STEADY',
      'NO_MONEY',
    ],
  },
  speech: {
    dedupeWindowMs: 5000,
    minGapMs: 400,
    guidanceStaleMs: 3000,
    maxUtteranceMs: 15000,
  },
  settings: {
    fontScaleMin: 1,
    fontScaleMax: 2,
    speechRates: [0.8, 1.0, 1.2],
    modelVersionMaxLength: 32,
  },
};

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  voiceEnabled: true,
  voiceLanguage: 'vi-VN',
  speechRate: 1.0,
  verbosity: 'DETAILED',
  speechOutput: 'APP_TTS',
  vibrationEnabled: true,
  torchEnabled: false,
  fontScale: 1,
  highContrast: false,
  autoStartCamera: true,
  modelVersion: '1.0.0',
};