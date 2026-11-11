// NGUỒN SỰ THẬT DUY NHẤT giữa các module (bản 2: đóng gói APK). Không module nào được tự sửa file này.

/* ───── Nền tảng, mệnh giá, lỗi ───── */
export type Platform = 'android-native' | 'web';

export const DENOMINATIONS = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000] as const;
export type Denomination = (typeof DENOMINATIONS)[number];

export type AppErrorCode =
  | 'UNSUPPORTED_BROWSER' | 'CAMERA_PERMISSION_DENIED' | 'CAMERA_NOT_FOUND' | 'CAMERA_IN_USE' | 'CAMERA_FAILED'
  | 'MODEL_MISSING' | 'MODEL_CORRUPT' | 'MODEL_INIT_FAILED' | 'INFERENCE_FAILED'
  | 'TTS_UNAVAILABLE' | 'TTS_NO_VIETNAMESE_VOICE' | 'STORAGE_FAILED' | 'OFFLINE_NOT_READY';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly fatal: boolean;
  readonly detail?: unknown;
  constructor(code: AppErrorCode, message: string, fatal = false, detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.fatal = fatal;
    this.detail = detail;
  }
}

/* ───── Khung hình & hình học ───── */
/** Pixel, gốc ở góc trên-trái, x1<x2, y1<y2. Với Detection: toạ độ trong KHUNG HÌNH GỐC. */
export interface BBox { x1: number; y1: number; x2: number; y2: number }
export interface FrameMeta { frameId: number; width: number; height: number; timestamp: number } // timestamp: performance.now() lúc chụp
export interface CapturedFrame { bitmap: ImageBitmap; meta: FrameMeta } // bên nhận chịu trách nhiệm bitmap.close()
export interface LetterboxMeta {
  inputSize: number; srcWidth: number; srcHeight: number;
  scale: number;                        // min(inputSize/srcWidth, inputSize/srcHeight)
  newWidth: number; newHeight: number;  // sau resize, làm tròn
  padX: number; padY: number;           // lề trái/trên, số nguyên
}
export interface GrayImage { data: Uint8Array; width: number; height: number } // 1 kênh, giữ tỷ lệ gốc, không có lề
export interface PreprocessResult { tensor: Float32Array; letterbox: LetterboxMeta; gray: GrayImage } // NCHW [1,3,S,S], RGB, 0..1

/* ───── Mô hình (file do P01 sinh, nằm trong public/models và được đóng sẵn vào APK) ───── */
export type ClassesJson = Record<string, Denomination>; // khoá = classId dạng chuỗi
export interface ModelManifest {
  version: string; file: string; sizeBytes: number; sha256: string;
  ultralytics: string; opset: number; classCount: number; exportedAt: string;
  inputName: string; inputShape: number[]; outputName: string; outputShape: number[];
}
export interface ModelConfigJson {
  inputSize: number; padValue: number;                 // padValue = 114
  channelOrder: 'RGB'; layout: 'NCHW'; normalize: 'div255';
  outputLayout: 'channels_first' | 'channels_last';    // [1,4+nc,N] | [1,N,4+nc]
  confLow: number; confSure: number; nmsIou: number; agnosticNms: boolean; maxDetections: number;
}
export interface RawModelOutput { data: Float32Array; dims: readonly number[] }
export interface ModelInfo {
  version: string; inputSize: number; classCount: number;
  backend: 'wasm' | 'webgpu'; threads: number; loadMs: number; warmupMs: number;
}

/* ───── Tiền xử lý & hậu xử lý (P03, P04 cài; P05 chỉ dùng qua interface) ───── */
export interface PreprocessorOptions { inputSize: number; padValue: number; grayThumbWidth: number }
export interface IPreprocessor { process(bitmap: ImageBitmap): PreprocessResult }
export interface PostProcessorOptions {
  classMap: readonly Denomination[];                   // classMap[classId] = mệnh giá (từ buildClassMap của P00)
  inference: AppConfig['inference'];
  layoutHint?: 'channels_first' | 'channels_last';
}
export interface IPostProcessor { process(raw: RawModelOutput, letterbox: LetterboxMeta, meta: FrameMeta): Detection[] }

/* ───── Phát hiện & suy luận ───── */
export interface Detection {
  id: string;                       // `${frameId}-${index}`
  classId: number; denomination: Denomination;
  confidence: number;               // 0..1
  bbox: BBox;                       // trong khung hình gốc
  frameId: number; timestamp: number;
}
export interface InferenceTimings { preprocessMs: number; inferMs: number; postprocessMs: number; totalMs: number }
/** detections đã sắp từ TRÁI sang PHẢI (tâm x tăng dần, hoà thì theo y). */
export interface InferenceResult { meta: FrameMeta; detections: Detection[]; gray: GrayImage; timings: InferenceTimings }

export type WorkerRequest =
  | { type: 'INIT'; modelBaseUrl: string; ortBaseUrl: string; config: AppConfig['inference'] }
  | { type: 'INFER'; meta: FrameMeta; bitmap: ImageBitmap }            // bitmap được transfer
  | { type: 'DISPOSE' };
export type WorkerResponse =
  | { type: 'READY'; info: ModelInfo }
  | { type: 'RESULT'; result: InferenceResult }
  | { type: 'DROPPED'; frameId: number }                             // worker đang bận
  | { type: 'ERROR'; code: AppErrorCode; message: string; fatal: boolean; frameId?: number };

/* ───── Camera & suy luận (interface) ───── */
export type CameraStatus = 'IDLE' | 'REQUESTING' | 'ACTIVE' | 'PAUSED' | 'ERROR';
/** Cổng điều khiển đèn pin dự phòng khi getUserMedia không điều khiển được đèn (một số WebView). */
export interface ITorchPort { isSupported(): Promise<boolean>; set(on: boolean): Promise<boolean> }
export interface ICameraService {
  readonly video: HTMLVideoElement;
  readonly status: CameraStatus;
  readonly torchSupported: boolean;
  start(): Promise<void>;                                  // ném AppError
  stop(): void;
  pause(): void;
  resume(): Promise<void>;
  setSampling(fps: number): void;
  onFrame(handler: (f: CapturedFrame) => void | Promise<void>): () => void; // handler async: camera chờ xong mới lấy khung kế
  onStatus(handler: (s: CameraStatus, error?: AppError) => void): () => void;
  setTorch(on: boolean): Promise<boolean>;                // true nếu bật/tắt được
}
export interface IInferenceClient {
  readonly ready: boolean;
  init(): Promise<ModelInfo>;                              // ném AppError
  infer(frame: CapturedFrame): Promise<InferenceResult | null>; // null = bị bỏ; luôn giải phóng bitmap
  dispose(): void;
}

/* ───── Phân tích khung hình ───── */
export interface FrameAnalysis {
  meta: FrameMeta;
  detections: Detection[];   // ≥ confLow, trái → phải
  sure: Detection[];         // ≥ confSure
  unsure: Detection[];       // [confLow, confSure)
  overlap: { detected: boolean; maxRatio: number; pairs: Array<[string, string]> };
  conflict: { detected: boolean; pairs: Array<[string, string]> };   // cùng vị trí nhưng khác mệnh giá
  position: { tooSmall: boolean; partial: boolean };
  quality: { blurScore: number; blurry: boolean; brightness: number; lowLight: boolean };
  stability: { stable: boolean; agree: number; window: number; consensus: Detection[] | null };
  emptyStreak: number;       // số khung liên tiếp không có detection nào
}
export interface IFrameAnalyzer { analyze(r: InferenceResult): FrameAnalysis; reset(): void }

/* ───── Quyết định ───── */
export type AppState =
  | 'INITIALIZING' | 'AWAITING_START' | 'WAITING_PERMISSION' | 'LOADING_MODEL' | 'READY'
  | 'NO_CANDIDATE' | 'DETECTING' | 'UNCERTAIN' | 'OVERLAPPING' | 'STABILIZING'
  | 'RESULT_READY' | 'SPEAKING' | 'ERROR';
export type DecisionStatus =
  | 'NO_MONEY_CANDIDATE' | 'LOW_CONFIDENCE' | 'CLASS_CONFLICT' | 'OVERLAP' | 'PARTIAL_IN_FRAME' | 'TOO_FAR'
  | 'BLUR' | 'LOW_LIGHT' | 'UNSTABLE' | 'MULTI_NOT_ALLOWED' | 'CONFIDENT_SINGLE' | 'CONFIDENT_MULTI';
export type GuidanceCode =
  | 'NO_MONEY' | 'TOO_FAR' | 'PARTIAL_IN_FRAME' | 'BLUR' | 'LOW_LIGHT' | 'LOW_CONFIDENCE'
  | 'CLASS_CONFLICT' | 'OVERLAP' | 'HOLD_STEADY' | 'MULTI_NOT_ALLOWED';
/** Chỉ tồn tại khi kết quả đã được xác nhận. denominations sắp từ trái sang phải. */
export interface RecognitionResult {
  status: 'CONFIDENT_SINGLE' | 'CONFIDENT_MULTI';
  count: number; denominations: Denomination[];
  total: number; formattedTotal: string;   // ví dụ '170.000 đồng'
  timestamp: number;
}
export type SettingAck =
  | 'VOICE_ON' | 'VIBRATION_ON' | 'VIBRATION_OFF' | 'TORCH_ON' | 'TORCH_OFF' | 'TORCH_UNSUPPORTED'
  | 'RATE_SLOW' | 'RATE_NORMAL' | 'RATE_FAST' | 'VERBOSITY_BRIEF' | 'VERBOSITY_DETAILED';
export type SpeechIntent =
  | { kind: 'WELCOME' } | { kind: 'PERMISSION_PRIMER' } | { kind: 'CAMERA_READY' }
  | { kind: 'GUIDANCE'; code: GuidanceCode }
  | { kind: 'RESULT'; result: RecognitionResult }
  | { kind: 'REPLAY'; result: RecognitionResult } | { kind: 'REPLAY_EMPTY' }
  | { kind: 'ERROR'; code: AppErrorCode }
  | { kind: 'SETTING_ACK'; what: SettingAck };
export type SystemEvent =
  | 'APP_STARTED' | 'GESTURE_UNLOCKED' | 'PERMISSION_REQUESTED' | 'MODEL_READY' | 'CAMERA_READY'
  | 'RESULT_SPEECH_ENDED' | 'APP_BACKGROUNDED' | 'APP_FOREGROUNDED';
export type DecisionInput =
  | { type: 'SYSTEM'; event: SystemEvent; now: number }
  | { type: 'FAILURE'; code: AppErrorCode; now: number }
  | { type: 'ANALYSIS'; analysis: FrameAnalysis; now: number }
  | { type: 'USER_REPLAY'; now: number };
export interface DecisionOutput {
  state: AppState;
  status: DecisionStatus | null;
  reasons: string[];                  // mã lý do để debug
  speech: SpeechIntent | null;        // tối đa 1 ý định nói mỗi lần
  result: RecognitionResult | null;   // khác null đúng 1 lần khi công bố kết quả mới
  shouldCalculateTotal: boolean;      // true chỉ khi đủ điều kiện công bố
}
export interface IDecisionEngine {
  readonly state: AppState;
  readonly lastResult: RecognitionResult | null;
  handle(input: DecisionInput): DecisionOutput;
  reset(): void;
}

/* ───── Giọng nói, rung, cài đặt ───── */
export interface TtsCapabilities {
  available: boolean; vietnameseVoice: boolean; offlineVietnamese: boolean;
  requiresUserGesture: boolean;   // true: phải có một lần chạm trước khi phát được tiếng (Web Speech, mp3 trong trình duyệt)
  voiceName?: string;
}
export interface TtsHooks { onStart(): void; onEnd(): void; onError(e: unknown): void }
export interface ITtsEngine {
  readonly name: 'native-tts' | 'web-speech' | 'audio-clip' | 'aria-live';
  init(): Promise<TtsCapabilities>;
  unlock(): void;
  speak(text: string, opts: { rate: number; lang: string; audioKey?: string }, hooks: TtsHooks): void;
  cancel(): void;
}
export interface UtteranceEvent { phase: 'start' | 'end'; kind: SpeechIntent['kind'] }
export interface ISpeech {
  readonly isSpeaking: boolean;
  init(): Promise<TtsCapabilities>;        // trả năng lực của engine ĐÃ CHỌN
  unlock(): void;                          // gọi trong thao tác chạm đầu tiên (nếu requiresUserGesture)
  say(intent: SpeechIntent): void;
  replayLast(): void;                      // đọc lại kết quả gần nhất, hoặc REPLAY_EMPTY
  cancelAll(): void;
  onUtterance(handler: (e: UtteranceEvent) => void): () => void;
}
export type HapticEvent = 'START' | 'SUCCESS' | 'UNCERTAIN' | 'ERROR';
export interface IHaptics { readonly supported: boolean; play(e: HapticEvent): void }

export interface Settings {
  schemaVersion: 1;
  voiceEnabled: boolean; voiceLanguage: 'vi-VN';
  speechRate: number;                      // 0.8 chậm · 1.0 thường · 1.2 nhanh
  verbosity: 'BRIEF' | 'DETAILED';
  speechOutput: 'APP_TTS' | 'SCREEN_READER';
  vibrationEnabled: boolean; torchEnabled: boolean;
  fontScale: number;                       // 1..2
  highContrast: boolean; autoStartCamera: boolean;
  modelVersion: string;
}
export interface ISettingsStore {
  load(): Promise<Settings>;
  save(patch: Partial<Settings>): Promise<Settings>;
  reset(): Promise<Settings>;
}

/* ───── Cấu hình (giá trị mặc định ở src/config/app-config.ts) ───── */
export interface AppConfig {
  inference: {
    confLow: number; confSure: number; nmsIou: number; agnosticNms: boolean;
    maxDetections: number; targetFps: number; preferWebGpu: boolean; verifyChecksum: boolean;
  };
  analyzer: {
    grayThumbWidth: number; overlapRatio: number; conflictIou: number;
    minAreaRatio: number; edgeMarginRatio: number; blurThreshold: number; lowLightMean: number;
    stabilizer: { windowSize: number; minAgree: number; matchIou: number; maxAgeMs: number };
  };
  decision: {
    multiNotePolicy: 'SINGLE_ONLY' | 'MULTI';
    blockOnPartial: boolean; blockOnBlur: boolean; blockOnLowLight: boolean;
    emptyFramesToReset: number; noMoneyGuidanceDelayMs: number; unstableGuidanceMs: number;
    guidanceCooldownMs: number; guidancePriority: GuidanceCode[];
  };
  speech: { dedupeWindowMs: number; minGapMs: number; guidanceStaleMs: number; maxUtteranceMs: number };
}