// Đồ giả riêng của test P11 (không phải file test): cổng giao diện, cổng vòng đời, cài đặt, bộ quyết định và bộ phân tích giả.
import type { AppDeps, AppLifecyclePort, AppScreen, AppSettings, AppUi, AppView, AssetCheck, UiAction } from '../../src/app/app';
import { DEFAULT_SETTINGS } from '../../src/config/app-config';
import type {
  AppError, AppErrorCode, AppState, DecisionInput, DecisionOutput, FrameAnalysis, IDecisionEngine, IFrameAnalyzer,
  InferenceResult, ITorchPort, Platform, SettingAck, Settings, SystemEvent, TtsCapabilities,
} from '../../src/contracts';
import { createFakeClock } from '../../src/utils/time';
import { FakeCamera, FakeHaptics, FakeInference, FakeSpeech, MemorySettingsStore, makeAnalysis } from '../fakes';
import type { FakeCameraOptions } from '../fakes';

/** Chờ các lời hứa đang treo chạy xong (không dùng hẹn giờ nên dùng được cả khi đang bật đồng hồ giả của vitest). */
export async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

export class FakeUi implements AppUi {
  readonly calls: string[] = [];
  readonly views: AppView[] = [];
  readonly errors: Array<{ code: AppErrorCode; detail?: string }> = [];
  gate: { unlock: () => void; onStart: () => void } | null = null;
  screen: AppScreen = 'camera';
  torch: { supported: boolean; on: boolean } | null = null;
  private readonly handlers = new Set<(a: UiAction) => void>();

  get listeners(): number {
    return this.handlers.size;
  }
  showStartGate(o: { unlock: () => void; onStart: () => void }): void {
    this.calls.push('showStartGate');
    this.gate = o;
  }
  hideStartGate(): void {
    this.gate = null;
  }
  showCamera(): void {
    this.calls.push('showCamera');
    this.screen = 'camera';
  }
  showSettings(): void {
    this.calls.push('showSettings');
    this.screen = 'settings';
  }
  showError(e: { code: AppErrorCode; detail?: string }): void {
    this.calls.push('showError');
    this.screen = 'error';
    this.errors.push(e);
  }
  render(view: AppView): void {
    this.views.push(view);
  }
  setTorch(t: { supported: boolean; on: boolean }): void {
    this.torch = t;
  }
  onAction(handler: (a: UiAction) => void): () => void {
    this.handlers.add(handler);
    return () => void this.handlers.delete(handler);
  }
  /** Người dùng bấm một nút hoặc làm một cử chỉ. */
  emit(a: UiAction): void {
    for (const h of [...this.handlers]) h(a);
  }
  /** Chạm cổng khởi động: giống createStartGate, unlock() rồi onStart() trong cùng một sự kiện. */
  tapGate(): void {
    const g = this.gate;
    if (g === null) throw new Error('Cổng khởi động chưa hiện');
    this.gate = null;
    g.unlock();
    g.onStart();
  }
}

export class FakeLifecycle implements AppLifecyclePort {
  minimizeCalls = 0;
  private readonly visibility = new Set<(v: boolean) => void>();
  private readonly back = new Set<() => void>();

  get listeners(): number {
    return this.visibility.size + this.back.size;
  }
  onVisibilityChange(handler: (visible: boolean) => void): () => void {
    this.visibility.add(handler);
    return () => void this.visibility.delete(handler);
  }
  onBackButton(handler: () => void): () => void {
    this.back.add(handler);
    return () => void this.back.delete(handler);
  }
  async minimize(): Promise<void> {
    this.minimizeCalls += 1;
  }
  setVisible(visible: boolean): void {
    for (const h of [...this.visibility]) h(visible);
  }
  pressBack(): void {
    for (const h of [...this.back]) h();
  }
}

/** Cài đặt giả trên MemorySettingsStore; mô phỏng ack của settings-manager cho đèn (TORCH_ON / TORCH_OFF). */
export class FakeSettings implements AppSettings {
  readonly patches: Array<Partial<Settings>> = [];
  private state: Settings;
  private readonly subs = new Set<(s: Settings) => void>();

  constructor(readonly store = new MemorySettingsStore(), private readonly onAck: (what: SettingAck) => void = () => undefined) {
    this.state = store.snapshot;
  }
  get listeners(): number {
    return this.subs.size;
  }
  async load(): Promise<Settings> {
    this.state = await this.store.load();
    return this.get();
  }
  get(): Settings {
    return { ...this.state };
  }
  async set(p: Partial<Settings>): Promise<Settings> {
    this.patches.push(p);
    const before = this.state;
    this.state = await this.store.save(p);
    if (p.torchEnabled !== undefined && p.torchEnabled !== before.torchEnabled) this.onAck(p.torchEnabled ? 'TORCH_ON' : 'TORCH_OFF');
    for (const h of [...this.subs]) h(this.get());
    return this.get();
  }
  subscribe(h: (s: Settings) => void): () => void {
    this.subs.add(h);
    return () => void this.subs.delete(h);
  }
}

/** Bộ phân tích giả: ghi lại các kết quả suy luận đã nhận. */
export class FakeAnalyzer implements IFrameAnalyzer {
  readonly analyzed: InferenceResult[] = [];
  resetCalls = 0;
  analyze(r: InferenceResult): FrameAnalysis {
    this.analyzed.push(r);
    return makeAnalysis({ meta: r.meta });
  }
  reset(): void {
    this.resetCalls += 1;
  }
}

/** Kịch bản mặc định: chỉ những gì app cần để thấy lời nói được chuyển tiếp. */
function defaultScript(i: DecisionInput): Partial<DecisionOutput> {
  if (i.type === 'FAILURE') return { state: 'ERROR', speech: { kind: 'ERROR', code: i.code } };
  if (i.type === 'USER_REPLAY') return { speech: { kind: 'REPLAY_EMPTY' } };
  if (i.type === 'SYSTEM' && i.event === 'APP_STARTED') return { speech: { kind: 'WELCOME' } };
  if (i.type === 'SYSTEM' && i.event === 'PERMISSION_REQUESTED') return { speech: { kind: 'PERMISSION_PRIMER' } };
  return {};
}

/** Bộ quyết định giả: ghi lại mọi đầu vào, trả đầu ra theo `script`. */
export class FakeDecision implements IDecisionEngine {
  readonly inputs: DecisionInput[] = [];
  resetCalls = 0;
  state: AppState = 'INITIALIZING';
  lastResult = null;
  script: (i: DecisionInput) => Partial<DecisionOutput> = defaultScript;

  get events(): SystemEvent[] {
    return this.inputs.flatMap((i) => (i.type === 'SYSTEM' ? [i.event] : []));
  }
  handle(input: DecisionInput): DecisionOutput {
    this.inputs.push(input);
    return { state: this.state, status: null, reasons: [], speech: null, result: null, shouldCalculateTotal: false, ...this.script(input) };
  }
  reset(): void {
    this.resetCalls += 1;
  }
}

export interface HarnessOptions {
  speechCaps?: Partial<TtsCapabilities>;
  settings?: Partial<Settings>;
  camera?: FakeCameraOptions;
  modelError?: AppError;
  assets?: AssetCheck | Error;
  platform?: Platform;
  torchPort?: ITorchPort;
}

/** Bộ đồ giả đủ để dựng createApp; test e2e thay analyzer, decision và speech bằng bản thật. */
export function makeDeps(o: HarnessOptions = {}) {
  const clock = createFakeClock(1000);
  const camera = new FakeCamera(o.camera);
  const inference = new FakeInference({ initError: o.modelError });
  const analyzer = new FakeAnalyzer();
  const decision = new FakeDecision();
  const speech = new FakeSpeech({ capabilities: o.speechCaps });
  const haptics = new FakeHaptics();
  const settings = new FakeSettings(new MemorySettingsStore({ ...DEFAULT_SETTINGS, ...o.settings }), (what) => speech.say({ kind: 'SETTING_ACK', what }));
  const ui = new FakeUi();
  const lifecycle = new FakeLifecycle();
  const assetResult = o.assets ?? { ok: true, missing: [], warnings: [] };
  const assets = async (): Promise<AssetCheck> => {
    if (assetResult instanceof Error) throw assetResult;
    return assetResult;
  };
  const deps: AppDeps = {
    camera, inference, analyzer, decision, speech, haptics, settings, assets,
    platform: o.platform ?? 'android-native', clock: clock.now, ui, lifecycle,
    ...(o.torchPort === undefined ? {} : { torchPort: o.torchPort }),
  };
  return { deps, clock, camera, inference, analyzer, decision, speech, haptics, settings, ui, lifecycle };
}