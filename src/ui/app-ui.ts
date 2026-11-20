/**
 * Bản cài thật của cổng AppUi (P11): ghép màn camera, màn cài đặt, màn lỗi, cổng khởi động và lớp debug trong một
 * thẻ gốc, mỗi lúc chỉ hiện một màn. Không chứa logic nghiệp vụ: app.ts quyết định, file này chỉ dựng và đổi màn.
 */
import { createStartGate } from '../accessibility/start-gate';
import type { AppScreen, AppUi, UiAction } from '../app/app';
import { systemClock } from '../utils/time';
import type { Clock } from '../utils/time';
import { createCameraScreen, describeStatus } from './camera-screen';
import { createDebugOverlay } from './debug-overlay';
import { createErrorScreen } from './error-screen';
import { createSettingsScreen } from './settings-screen';
import type { UiSettings } from './settings-screen';

export interface AppUiHandle extends AppUi {
  /** Thẻ video của màn camera: đưa cho createCameraService({ video }). */
  readonly video: HTMLVideoElement;
  dispose(): void;
}

export function createAppUi(
  o: { root: HTMLElement; settings: UiSettings; onReplayGuide: () => void; debug?: boolean; now?: Clock },
): AppUiHandle {
  const doc = o.root.ownerDocument;
  const handlers = new Set<(a: UiAction) => void>();
  const emit = (a: UiAction): void => {
    for (const h of [...handlers]) h(a);
  };

  const camera = createCameraScreen({ doc, onReplay: () => emit('REPLAY'), onToggleTorch: () => emit('TOGGLE_TORCH'), onOpenSettings: () => emit('OPEN_SETTINGS') });
  const settingsScreen = createSettingsScreen({ doc, settings: o.settings, onReplayGuide: o.onReplayGuide, onClose: () => emit('CLOSE_SETTINGS') });
  const errorScreen = createErrorScreen({ doc, onRetry: () => emit('RETRY'), showDetail: o.debug === true });
  o.root.append(camera.el, settingsScreen.el, errorScreen.el);
  const overlay = o.debug === true ? createDebugOverlay({ doc, surface: camera.surface, panelHost: camera.overlay, now: o.now ?? systemClock }) : null;
  let gate: { show(): void; hide(): void } | null = null;

  function showOnly(name: AppScreen): void {
    if (name === 'camera') camera.show();
    else camera.hide();
    if (name !== 'settings') settingsScreen.hide();
    if (name !== 'error') errorScreen.hide();
  }

  return {
    video: camera.video,
    showStartGate({ unlock, onStart }) {
      gate?.hide();
      gate = createStartGate({ root: camera.el, unlock, onStart });
      gate.show();
    },
    hideStartGate() {
      gate?.hide();
      gate = null;
    },
    showCamera() {
      showOnly('camera');
      camera.focusReplay();
    },
    showSettings() {
      showOnly('settings');
      settingsScreen.show();
    },
    showError(e) {
      showOnly('error');
      errorScreen.show(e);
    },
    render(view) {
      camera.setStatusText(describeStatus(view));
      overlay?.update(view);
    },
    setTorch: (t) => camera.setTorch(t),
    onAction(handler) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    dispose() {
      handlers.clear();
      gate?.hide();
      overlay?.dispose();
      camera.dispose();
      settingsScreen.dispose();
      errorScreen.dispose();
    },
  };
}