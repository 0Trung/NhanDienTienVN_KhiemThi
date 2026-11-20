/**
 * Điểm vào của ứng dụng: dựng các bản cài THẬT rồi nối vào createApp. Không có logic nghiệp vụ ở đây.
 * Thứ tự dựng: cài đặt → giao diện (cho thẻ video) → camera → suy luận → rung → giọng nói → app.
 * Lớp debug chỉ bật khi có ?debug=1 hoặc khi dựng ở chế độ development (vite --mode development); bản release không có.
 */
import './ui/styles.css';
import { createAriaLiveEngine } from './accessibility/aria-live-engine';
import { createSettingsManager } from './accessibility/settings-manager';
import { createFrameAnalyzer } from './analyzer/frame-analyzer';
import { createApp } from './app/app';
import type { App } from './app/app';
import { createAppLifecyclePort } from './app/app-lifecycle-adapter';
import { createNativeTorchPort } from './app/native-torch';
import { createCameraService } from './camera/camera-controller';
import { DEFAULT_CONFIG } from './config/app-config';
import type { SettingAck } from './contracts';
import { createDecisionEngine } from './decision/decision-engine';
import { checkBundledAssets } from './offline/asset-check';
import { createSettingsStore } from './offline/settings-store';
import { createAppUi } from './ui/app-ui';
import { createLogger } from './utils/logger';
import { getPlatform } from './utils/platform';
import { systemClock } from './utils/time';
import { createInferenceClient } from './vision/inference-client';
import { createAudioClipEngine } from './voice/audio-clip-engine';
import { createHaptics } from './voice/haptic-service';
import { createNativeTtsEngine } from './voice/native-tts-engine';
import { createSpeechManager } from './voice/speech-manager';
import { createWebSpeechEngine } from './voice/web-speech-engine';

const log = createLogger('main');

function bootstrap(): App {
  const root = document.getElementById('app');
  if (root === null) throw new Error('Thiếu phần tử #app trong index.html');
  const config = DEFAULT_CONFIG;
  const base = import.meta.env.BASE_URL; // './' (Vite base): mọi tài nguyên nằm sẵn trong APK
  const debug = new URLSearchParams(window.location.search).get('debug') === '1' || import.meta.env.MODE === 'development';

  // Lời xác nhận khi đổi cài đặt đi qua bộ nói; bộ nói được dựng sau cài đặt nên nối muộn.
  let acknowledge: (what: SettingAck) => void = () => undefined;
  const settings = createSettingsManager(createSettingsStore(), (what) => acknowledge(what));

  const ui = createAppUi({ root, settings, debug, now: systemClock, onReplayGuide: () => speech.say({ kind: 'WELCOME' }) });
  const torchPort = createNativeTorchPort();
  const camera = createCameraService({ video: ui.video, fps: config.inference.targetFps, torchPort });
  const inference = createInferenceClient({ modelBaseUrl: `${base}models/`, ortBaseUrl: `${base}ort/`, config: config.inference });
  const haptics = createHaptics({ isEnabled: () => settings.get().vibrationEnabled });
  const speech = createSpeechManager({
    engines: [createNativeTtsEngine(), createWebSpeechEngine(), createAudioClipEngine({ baseUrl: base }), createAriaLiveEngine({ root })],
    haptics,
    getSettings: () => settings.get(),
    config: config.speech,
  });
  acknowledge = (what) => speech.say({ kind: 'SETTING_ACK', what });

  return createApp({
    camera, inference, analyzer: createFrameAnalyzer(config), decision: createDecisionEngine(config.decision),
    speech, haptics, settings, ui, torchPort, platform: getPlatform(), clock: systemClock,
    assets: () => checkBundledAssets({ baseUrl: base }), lifecycle: createAppLifecyclePort(), config,
  });
}

/** Lưới an toàn cuối cùng: nếu không dựng nổi giao diện thì vẫn phải có chữ (không để màn hình đen im lặng). */
function showFatal(message: string): void {
  const note = document.createElement('p');
  note.setAttribute('role', 'alert');
  note.style.cssText = 'margin:0;padding:1rem;color:#fff;font:700 1.5rem/1.4 system-ui,sans-serif';
  note.textContent = message;
  (document.getElementById('app') ?? document.body).replaceChildren(note);
}

try {
  void bootstrap().start(); // không dispose ở pagehide: WebView đóng thì camera và worker tự dừng, còn dispose nhầm là tắt app vĩnh viễn
} catch (e) {
  log.error('Không dựng được ứng dụng', e);
  showFatal('Không khởi động được ứng dụng. Hãy đóng ứng dụng rồi mở lại.');
}