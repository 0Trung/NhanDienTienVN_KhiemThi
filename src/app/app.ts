/**
 * Bộ ráp ứng dụng (P11): nối camera → suy luận → phân tích → quyết định → giọng nói thành một vòng chạy liên tục,
 * cùng vòng đời app, nút Back, đèn pin và các màn hình. File này CHỈ NỐI DÂY:
 * - mọi quyết định "đọc hay không đọc" là của DecisionEngine; app chỉ chuyển đầu vào và phát lại đầu ra;
 * - mọi việc chạm DOM hay plugin nằm sau hai cổng nhỏ (AppUi, AppLifecyclePort) hoặc các interface của Khối B,
 *   nên chạy được trong Node với đồ giả. Không import lớp cụ thể của module khác.
 *
 * Mọi lời nói đều đi ra từ DecisionOutput.speech (kể cả WELCOME, PERMISSION_PRIMER, CAMERA_READY do engine phát
 * khi vào trạng thái khởi động). Ngoại lệ có chủ đích: lỗi giọng tiếng Việt, xác nhận đèn không hỗ trợ.
 */
import { DEFAULT_CONFIG } from '../config/app-config';
import { AppError } from '../contracts';
import type {
  AppConfig, AppErrorCode, AppState, CameraStatus, CapturedFrame, DecisionOutput, DecisionStatus, Detection, FrameMeta,
  ICameraService, IDecisionEngine, IFrameAnalyzer, IHaptics, IInferenceClient, InferenceResult, InferenceTimings,
  ISpeech, ITorchPort, Platform, RecognitionResult, Settings, SystemEvent, TtsCapabilities, UtteranceEvent,
} from '../contracts';
import { createLogger } from '../utils/logger';
import { mean } from '../utils/math';
import type { Clock } from '../utils/time';

const log = createLogger('app');

/** Số mili-giây trong một giây (đổi fps sang khoảng cách lấy mẫu). */
const MS_PER_SECOND = 1000;

/**
 * Nhịp thích ứng (mục 9): khi độ trễ trung bình của `window` khung gần nhất vượt `latencyFactor` lần khoảng cách
 * lấy mẫu thì hạ fps `step` bậc, không thấp hơn `minFps`. AppConfig chưa có các tham số này nên tạm đặt ở đây
 * (xem "Đề xuất sửa hợp đồng").
 */
export const ADAPTIVE_FPS = { latencyFactor: 2, window: 5, step: 1, minFps: 1 } as const;

/** Số khung liên tiếp suy luận lỗi (không nghiêm trọng) thì coi là INFERENCE_FAILED. Cũng nên nằm trong AppConfig. */
export const INFERENCE_FAILURE_LIMIT = 5;

/** Mã lỗi dùng khi khởi động hỏng vì một ngoại lệ không lường trước (không phải AppError). */
const STARTUP_FALLBACK_CODE: AppErrorCode = 'MODEL_INIT_FAILED';

const NO_SPEECH: TtsCapabilities = { available: false, vietnameseVoice: false, offlineVietnamese: false, requiresUserGesture: false };

/* ───── Cổng và kiểu của app ───── */

/** Màn hình đang hiện: nút Back và việc tạm dừng quét phụ thuộc vào đây. */
export type AppScreen = 'camera' | 'settings' | 'error';

/** Thao tác của người dùng do lớp giao diện báo lên (nút hoặc cử chỉ). */
export type UiAction = 'REPLAY' | 'TOGGLE_TORCH' | 'OPEN_SETTINGS' | 'CLOSE_SETTINGS' | 'RETRY';

/** Số liệu của khung vừa xử lý, dùng cho lớp debug. KHÔNG chứa ảnh (Privacy First). */
export interface ScanFrameView {
  meta: FrameMeta;
  detections: readonly Detection[];
  timings: InferenceTimings;
  /** Từ lúc nhận khung đến lúc quyết định xong (mili-giây). */
  latencyMs: number;
  /** Tốc độ lấy mẫu đang đặt cho camera (khung/giây). */
  samplingFps: number;
}

/** Dữ liệu để vẽ vùng trạng thái chữ to và lớp debug; được đẩy sau mỗi khung và mỗi lần đổi trạng thái. */
export interface AppView {
  state: AppState;
  status: DecisionStatus | null;
  reasons: readonly string[];
  /** Kết quả đã công bố gần nhất (để hiện chữ to); null nếu chưa có. */
  result: RecognitionResult | null;
  /** null khi cập nhật không đến từ một khung hình (sự kiện hệ thống). */
  frame: ScanFrameView | null;
}

/** Cổng giao diện: app chỉ gọi các hàm này, không chạm DOM. Bản thật nằm ở src/ui (kèm accessibility-manager). */
export interface AppUi {
  /** Hiện cổng khởi động; lớp giao diện gọi unlock() RỒI onStart() ngay trong sự kiện kích hoạt. */
  showStartGate(o: { unlock: () => void; onStart: () => void }): void;
  hideStartGate(): void;
  showCamera(): void;
  showSettings(): void;
  showError(e: { code: AppErrorCode; detail?: string }): void;
  render(view: AppView): void;
  /** Trạng thái nút đèn: có hỗ trợ không, đang bật không (phản ánh đèn THẬT). */
  setTorch(t: { supported: boolean; on: boolean }): void;
  onAction(handler: (a: UiAction) => void): () => void;
}

/** Cổng vòng đời: hợp nhất visibilitychange và appStateChange của Capacitor, cộng nút Back của Android. */
export interface AppLifecyclePort {
  /** handler(true) khi app hiện, handler(false) khi ẩn. Hai nguồn có thể báo trùng: người nhận phải chịu được. */
  onVisibilityChange(handler: (visible: boolean) => void): () => void;
  onBackButton(handler: () => void): () => void;
  /** Thu nhỏ app, không thoát hẳn. Ngoài Android thì không làm gì. */
  minimize(): Promise<void>;
}

/** Phần của settings-manager (P10) mà app dùng. */
export interface AppSettings {
  load(): Promise<Settings>;
  get(): Settings;
  set(p: Partial<Settings>): Promise<Settings>;
  subscribe(h: (s: Settings) => void): () => void;
}

/** Kết quả kiểm tra gói tài nguyên, đúng với kiểu trả về của checkBundledAssets (P09). */
export interface AssetCheck {
  ok: boolean;
  missing: string[];
  warnings: string[];
  error?: AppError;
}

export interface AppDeps {
  camera: ICameraService;
  inference: IInferenceClient;
  analyzer: IFrameAnalyzer;
  decision: IDecisionEngine;
  speech: ISpeech;
  haptics: IHaptics;
  settings: AppSettings;
  /** Thường là () => checkBundledAssets({ baseUrl }). */
  assets: () => Promise<AssetCheck>;
  /** Cổng đèn native (dự phòng); app dùng nó để chắc chắn đèn tắt khi dừng. Camera đã nhận cùng cổng này khi dựng. */
  torchPort?: ITorchPort;
  platform: Platform;
  clock: Clock;
  /** Mở rộng so với danh sách trong đề: app cần cổng giao diện và cổng vòng đời để không chạm DOM/plugin. */
  ui: AppUi;
  lifecycle: AppLifecyclePort;
  /** Mặc định DEFAULT_CONFIG. */
  config?: AppConfig;
}

export interface App {
  /** Chạy toàn bộ trình tự khởi động. Không bao giờ ném lỗi: lỗi được báo bằng giọng nói và màn hình lỗi. */
  start(): Promise<void>;
  dispose(): void;
}

/* ───── Hàm phụ thuần ───── */

const codeOf = (e: unknown, fallback: AppErrorCode): AppErrorCode => (e instanceof AppError ? e.code : fallback);

/** Chạy fn trong một Promise để lỗi ném đồng bộ cũng thành lời từ chối. */
function attempt<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(fn()));
}

function discard(frame: CapturedFrame): void {
  try {
    frame.bitmap.close();
  } catch (e) {
    log.debug('Không đóng được bitmap', e);
  }
}

export function createApp(deps: AppDeps): App {
  const { camera, inference, analyzer, decision, speech, haptics, settings, assets, torchPort, platform, clock, ui, lifecycle } = deps;
  const config = deps.config ?? DEFAULT_CONFIG;

  const permanent: Array<() => void> = []; // listener sống suốt đời app; dispose gỡ hết
  let settingsOff: (() => void) | null = null;
  let frameOff: (() => void) | null = null; // chỉ có khi đang quét
  let gateResolve: (() => void) | null = null;

  let disposed = false;
  let started = false;
  let bound = false;
  let runId = 0; // tăng mỗi lần start/dispose: kết quả bất đồng bộ của lượt cũ bị bỏ
  let unlocked = false;
  let screen: AppScreen = 'camera';
  let backgrounded = false;
  let cameraUp = false; // camera.start() đã xong trong lượt này
  let scanning = false; // camera đang chạy theo ý app (đối chiếu với pause/resume)
  let torchOn = false;
  let torchBusy = false;
  let samplingFps: number = config.inference.targetFps;
  let speechOutput: Settings['speechOutput'] = settings.get().speechOutput;
  let lastResult: RecognitionResult | null = null;
  let inferenceFailures = 0;
  const latencies: number[] = [];

  const stale = (run: number): boolean => disposed || run !== runId;
  const halted = (run: number): boolean => stale(run) || screen === 'error';

  function safely(label: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      log.error(`${label} ném lỗi`, e);
    }
  }

  /* ───── Kênh ra: lời nói và giao diện ───── */

  function publish(out: DecisionOutput, frame: ScanFrameView | null): void {
    if (out.result !== null) lastResult = out.result;
    safely('ui.render', () => ui.render({ state: out.state, status: out.status, reasons: out.reasons, result: lastResult, frame }));
  }

  /** Gửi sự kiện hệ thống cho engine, phát lại lời nói (trừ khi giữ lại) và cập nhật giao diện. */
  function send(event: SystemEvent, holdSpeech = false): DecisionOutput {
    const out = decision.handle({ type: 'SYSTEM', event, now: clock() });
    if (!holdSpeech && out.speech !== null) speech.say(out.speech);
    publish(out, null);
    return out;
  }

  function renderTorch(): void {
    safely('ui.setTorch', () => ui.setTorch({ supported: camera.torchSupported, on: torchOn }));
  }

  /* ───── Dừng và báo lỗi ───── */

  function haltScanning(): void {
    frameOff?.();
    frameOff = null;
    cameraUp = false;
    scanning = false;
    torchOn = false; // dừng camera là đèn tắt
    latencies.length = 0;
    inferenceFailures = 0;
    safely('camera.stop', () => camera.stop());
    safely('inference.dispose', () => inference.dispose());
  }

  /** Lỗi nghiêm trọng: dừng quét, gửi FAILURE, nói ERROR bằng giọng VÀ hiện màn hình lỗi (không để màn hình đen im lặng). */
  function fail(code: AppErrorCode, cause?: unknown): void {
    if (disposed || screen === 'error') return;
    log.error(`Lỗi ${code}`, cause ?? '');
    haltScanning();
    screen = 'error';
    const out = decision.handle({ type: 'FAILURE', code, now: clock() });
    if (out.speech !== null) speech.say(out.speech);
    publish(out, null);
    const detail = cause instanceof Error ? cause.message : undefined;
    safely('ui.showError', () => ui.showError({ code, detail }));
  }

  /* ───── Vòng quét ───── */

  /** Hạ fps một bậc khi độ trễ trung bình quá lớn so với khoảng cách lấy mẫu. */
  function trackLatency(ms: number): void {
    latencies.push(ms);
    if (latencies.length > ADAPTIVE_FPS.window) latencies.shift();
    if (latencies.length < ADAPTIVE_FPS.window) return;
    const average = mean(latencies);
    const limit = ADAPTIVE_FPS.latencyFactor * (MS_PER_SECOND / samplingFps);
    if (average <= limit) return;
    const next = Math.max(ADAPTIVE_FPS.minFps, samplingFps - ADAPTIVE_FPS.step);
    if (next === samplingFps) return;
    log.warn(`Độ trễ trung bình ${Math.round(average)} ms vượt ${Math.round(limit)} ms: hạ lấy mẫu ${samplingFps} → ${next} fps`);
    samplingFps = next;
    camera.setSampling(samplingFps);
    latencies.length = 0;
  }

  function onInferenceError(e: unknown): void {
    if (e instanceof AppError && e.fatal) return fail(e.code, e);
    inferenceFailures += 1;
    log.warn(`Suy luận lỗi (${inferenceFailures}/${INFERENCE_FAILURE_LIMIT})`, e);
    if (inferenceFailures >= INFERENCE_FAILURE_LIMIT) fail(codeOf(e, 'INFERENCE_FAILED'), e);
  }

  async function onFrame(frame: CapturedFrame): Promise<void> {
    if (!scanning) return discard(frame); // khung đến muộn sau khi tạm dừng: bên nhận phải đóng bitmap
    const run = runId;
    const startedAt = clock();
    let result: InferenceResult | null;
    try {
      result = await inference.infer(frame);
    } catch (e) {
      if (!halted(run)) onInferenceError(e);
      return;
    }
    if (halted(run) || !scanning) return;
    inferenceFailures = 0; // infer trả lời được (kể cả null) nghĩa là bộ suy luận còn sống
    if (result === null) return; // khung bị bỏ: không phân tích
    const analysis = analyzer.analyze(result);
    const out = decision.handle({ type: 'ANALYSIS', analysis, now: clock() });
    if (out.speech !== null) speech.say(out.speech);
    const latencyMs = clock() - startedAt;
    publish(out, { meta: result.meta, detections: result.detections, timings: result.timings, latencyMs, samplingFps });
    trackLatency(latencyMs);
  }

  function startLoop(): void {
    frameOff?.();
    frameOff = camera.onFrame(onFrame);
  }

  /** Đưa camera về đúng trạng thái app muốn: chạy khi đang hiện, ở màn camera; ngược lại tạm dừng. */
  function syncCamera(): void {
    if (!cameraUp) return;
    const want = !backgrounded && screen === 'camera';
    if (want === scanning) return;
    scanning = want;
    if (want) attempt(() => camera.resume()).catch((e: unknown) => log.warn('camera.resume lỗi', e));
    else safely('camera.pause', () => camera.pause());
  }

  /* ───── Trình tự khởi động ───── */

  async function checkAssets(): Promise<AssetCheck> {
    try {
      return await assets();
    } catch (e) {
      log.error('Kiểm tra gói tài nguyên bị lỗi', e);
      return { ok: false, missing: ['(không kiểm tra được gói tài nguyên)'], warnings: [] };
    }
  }

  async function loadSettings(): Promise<void> {
    try {
      await settings.load();
      // Đèn luôn tắt khi mở app (app không tự bật đèn): đưa giá trị đã lưu về đúng thực tế, lúc giọng nói chưa sẵn sàng.
      if (settings.get().torchEnabled) await settings.set({ torchEnabled: false });
    } catch (e) {
      log.warn('Không nạp được cài đặt, dùng giá trị hiện có', e);
    }
    speechOutput = settings.get().speechOutput;
    settingsOff?.();
    settingsOff = settings.subscribe(onSettings);
  }

  async function initSpeech(): Promise<TtsCapabilities> {
    try {
      return await speech.init();
    } catch (e) {
      log.error('speech.init lỗi', e);
      return NO_SPEECH;
    }
  }

  /** Đổi cách đọc (giọng app / trình đọc màn hình) thì phải chọn lại engine. */
  function onSettings(s: Settings): void {
    if (s.speechOutput === speechOutput) return;
    speechOutput = s.speechOutput;
    void initSpeech();
  }

  function waitForGate(): Promise<void> {
    return new Promise<void>((resolve) => {
      gateResolve = resolve;
      try {
        ui.showStartGate({
          unlock: () => safely('speech.unlock', () => speech.unlock()), // trong chính sự kiện kích hoạt
          onStart: () => {
            gateResolve = null;
            resolve();
          },
        });
      } catch (e) {
        log.error('Không hiện được cổng khởi động, tự bắt đầu', e);
        gateResolve = null;
        resolve();
      }
    });
  }

  function onCameraStarted(): void {
    cameraUp = true;
    scanning = true;
    send('CAMERA_READY');
    renderTorch();
  }

  /** Quyền camera: engine nói PERMISSION_PRIMER khi nhận PERMISSION_REQUESTED, rồi mới mở camera; mô hình nạp song song. */
  async function begin(run: number): Promise<void> {
    camera.setSampling(samplingFps);
    send('PERMISSION_REQUESTED');
    const model = attempt(() => inference.init()).then(
      () => {
        if (!halted(run)) send('MODEL_READY');
      },
      (e: unknown) => {
        if (!halted(run)) fail(codeOf(e, 'MODEL_INIT_FAILED'), e);
      },
    );
    const cam = attempt(() => camera.start()).then(
      () => {
        if (!halted(run)) onCameraStarted();
      },
      (e: unknown) => {
        if (!halted(run)) fail(codeOf(e, 'CAMERA_FAILED'), e);
      },
    );
    await Promise.all([model, cam]);
    if (halted(run)) return;
    startLoop();
    syncCamera();
  }

  async function boot(run: number): Promise<void> {
    bind();
    screen = 'camera';
    safely('ui.showCamera', () => ui.showCamera());
    log.info(`Khởi động trên nền tảng ${platform}`);

    // 1. Boot: kiểm tra gói, nạp cài đặt, chọn engine giọng nói (cần có trước khi nói được lỗi).
    const check = await checkAssets();
    if (stale(run)) return;
    await loadSettings();
    if (stale(run)) return;
    const caps = await initSpeech();
    if (stale(run)) return;
    if (!check.ok) {
      log.error('Gói thiếu tài nguyên', check.missing);
      return fail('OFFLINE_NOT_READY');
    }
    if (!caps.available) return fail('TTS_UNAVAILABLE');
    const welcome = send('APP_STARTED', true); // lời chào chỉ được nói SAU khi giọng nói đã được mở khóa

    // 2. Bắt đầu: cần một lần chạm nếu engine đòi, hoặc nếu người dùng tắt "Tự bật camera".
    if (!unlocked && (caps.requiresUserGesture || !settings.get().autoStartCamera)) {
      await waitForGate();
      if (stale(run)) return;
    }
    unlocked = true;
    if (!caps.vietnameseVoice) speech.say({ kind: 'ERROR', code: 'TTS_NO_VIETNAMESE_VOICE' }); // vẫn chạy, qua engine dự phòng
    if (welcome.speech !== null) speech.say(welcome.speech);
    send('GESTURE_UNLOCKED');

    // 3. Camera và mô hình.
    await begin(run);
  }

  async function start(): Promise<void> {
    if (disposed || started) return;
    started = true;
    const run = ++runId;
    try {
      await boot(run);
    } catch (e) {
      if (!stale(run)) fail(codeOf(e, STARTUP_FALLBACK_CODE), e);
    }
  }

  /** Thử lại sau lỗi: làm lại từ đầu (không hiện lại cổng vì người dùng vừa chạm). */
  async function retry(): Promise<void> {
    if (disposed || screen !== 'error') return;
    log.info('Thử lại sau lỗi');
    safely('speech.cancelAll', () => speech.cancelAll());
    decision.reset();
    analyzer.reset();
    lastResult = null;
    started = false;
    await start();
  }

  /* ───── Thao tác người dùng ───── */

  function replay(): void {
    const out = decision.handle({ type: 'USER_REPLAY', now: clock() });
    if (out.speech !== null) speech.say(out.speech);
    publish(out, null);
  }

  /** Đèn chỉ đổi khi người dùng bấm nút hoặc giữ màn hình; không được thì nói TORCH_UNSUPPORTED. */
  async function toggleTorch(): Promise<void> {
    if (torchBusy || screen !== 'camera') return;
    torchBusy = true;
    try {
      const next = !torchOn;
      let ok = false;
      try {
        ok = await camera.setTorch(next);
      } catch (e) {
        log.warn('camera.setTorch lỗi', e);
      }
      if (!ok) {
        speech.say({ kind: 'SETTING_ACK', what: 'TORCH_UNSUPPORTED' });
      } else {
        torchOn = next;
        await settings.set({ torchEnabled: next }); // settings-manager lưu rồi nói TORCH_ON / TORCH_OFF
      }
      renderTorch();
    } catch (e) {
      log.warn('Đổi cài đặt đèn lỗi', e);
    } finally {
      torchBusy = false;
    }
  }

  function openSettings(): void {
    if (screen !== 'camera') return;
    screen = 'settings';
    safely('ui.showSettings', () => ui.showSettings());
    syncCamera(); // đang chỉnh cài đặt thì không quét: lời xác nhận không bị hướng dẫn chen ngang
  }

  function closeSettings(): void {
    if (screen !== 'settings') return;
    screen = 'camera';
    safely('ui.showCamera', () => ui.showCamera());
    analyzer.reset();
    syncCamera();
  }

  function onAction(a: UiAction): void {
    switch (a) {
      case 'REPLAY':
        replay();
        break;
      case 'TOGGLE_TORCH':
        void toggleTorch();
        break;
      case 'OPEN_SETTINGS':
        openSettings();
        break;
      case 'CLOSE_SETTINGS':
        closeSettings();
        break;
      case 'RETRY':
        void retry();
        break;
      default: {
        const unsupported: never = a;
        log.warn('Thao tác không được hỗ trợ', unsupported);
      }
    }
  }

  /* ───── Vòng đời, nút Back, trạng thái camera, lời nói ───── */

  /** Hai nguồn (visibilitychange, appStateChange) có thể báo trùng: chỉ hành động khi trạng thái thật sự đổi. */
  function onVisibility(visible: boolean): void {
    if (disposed || backgrounded === !visible) return;
    backgrounded = !visible;
    syncCamera();
    if (!visible) {
      safely('speech.cancelAll', () => speech.cancelAll());
      send('APP_BACKGROUNDED');
      return;
    }
    analyzer.reset(); // cửa sổ ổn định cũ không còn đúng sau khi camera tạm dừng
    send('APP_FOREGROUNDED');
    if (scanning) haptics.play('START'); // báo bằng rung: quét đã tiếp tục (việc tiếp tục không có lời nói)
  }

  function onBack(): void {
    if (screen === 'settings') return closeSettings();
    attempt(() => lifecycle.minimize()).catch((e: unknown) => log.warn('Không thu nhỏ được ứng dụng', e));
  }

  /** Lỗi camera giữa chừng (mất camera, không mở lại được) cũng phải báo, không để màn hình đen im lặng. */
  function onCameraStatus(status: CameraStatus, error?: AppError): void {
    if (status === 'ERROR' && error !== undefined) fail(error.code, error);
  }

  /** RESULT_SPEECH_ENDED chỉ gửi khi một câu RESULT hoặc REPLAY vừa đọc xong. */
  function onUtterance(e: UtteranceEvent): void {
    if (e.phase === 'end' && (e.kind === 'RESULT' || e.kind === 'REPLAY')) send('RESULT_SPEECH_ENDED');
  }

  function bind(): void {
    if (bound) return;
    bound = true;
    permanent.push(ui.onAction(onAction));
    permanent.push(speech.onUtterance(onUtterance));
    permanent.push(camera.onStatus(onCameraStatus));
    permanent.push(lifecycle.onVisibilityChange(onVisibility));
    if (platform === 'android-native') permanent.push(lifecycle.onBackButton(onBack)); // Back chỉ có trên Android
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    runId += 1;
    const pendingGate = gateResolve;
    gateResolve = null;
    pendingGate?.(); // start() đang chờ cổng thì được thả ra rồi tự thoát
    safely('ui.hideStartGate', () => ui.hideStartGate());
    for (const off of permanent.splice(0)) safely('gỡ listener', off);
    settingsOff?.();
    settingsOff = null;
    const lightWasOn = torchOn;
    haltScanning();
    safely('speech.cancelAll', () => speech.cancelAll());
    if (lightWasOn && torchPort !== undefined) attempt(() => torchPort.set(false)).catch((e: unknown) => log.warn('Không tắt được đèn', e));
  }

  return { start, dispose };
}