// @vitest-environment happy-dom
// Test giao diện nhẹ (P11): nhãn nút, đổi màn, màn cài đặt, màn lỗi, cổng khởi động, lớp debug chỉ có khi bật cờ,
// và một bài ghép createApp với giao diện thật. Phần cần module P10 thật tự bỏ qua (ghi lý do vào log) khi nó còn là stub.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAccessibilityManager } from '../../src/accessibility/accessibility-manager';
import { createGestureController } from '../../src/accessibility/gesture-controller';
import { buildSettingsViewModel } from '../../src/accessibility/settings-view-model';
import { createStartGate } from '../../src/accessibility/start-gate';
import { createApp } from '../../src/app/app';
import type { AppView, UiAction } from '../../src/app/app';
import { DEFAULT_SETTINGS } from '../../src/config/app-config';
import { AppError } from '../../src/contracts';
import type { AppErrorCode, RecognitionResult } from '../../src/contracts';
import { createAppUi } from '../../src/ui/app-ui';
import { describeStatus } from '../../src/ui/camera-screen';
import { MAX_DEBUG_ENTRIES, createDebugOverlay } from '../../src/ui/debug-overlay';
import { ERROR_MESSAGES, RETRY_LABEL } from '../../src/ui/error-screen';
import { SETTINGS_CLOSE_LABEL } from '../../src/ui/settings-screen';
import { createLogger, setLogSink } from '../../src/utils/logger';
import { FakeSettings, flush, makeDeps } from '../app/app-fakes';

const noop = (): void => undefined;
const REAL_MODULES: ReadonlyArray<readonly [string, () => unknown]> = [
  ['createAccessibilityManager', () => createAccessibilityManager({ root: document.createElement('div'), torchSupported: false, onReplay: noop, onToggleTorch: noop, onOpenSettings: noop })],
  ['createGestureController', () => createGestureController({ surface: document.createElement('div'), onReplay: noop, onToggleTorch: noop })],
  ['createStartGate', () => createStartGate({ root: document.createElement('div'), onStart: noop, unlock: noop })],
  ['buildSettingsViewModel', () => buildSettingsViewModel(() => DEFAULT_SETTINGS, async () => DEFAULT_SETTINGS, { onReplayGuide: noop })],
];
const stubs = REAL_MODULES.filter(([, make]) => {
  try {
    make();
    return false;
  } catch (e) {
    return e instanceof Error && e.message.startsWith('STUB:');
  }
}).map(([name]) => name);
const needsP10 = stubs.length > 0 ? describe.skip : describe;
if (stubs.length > 0) createLogger('ui-test').warn(`BỎ QUA test giao diện vì còn là stub: ${stubs.join(', ')}`);

beforeAll(() => setLogSink(() => undefined));
afterAll(() => setLogSink(null));

const view = (o: Partial<AppView> = {}): AppView => ({ state: 'READY', status: null, reasons: [], result: null, frame: null, ...o });
const result = (count: number, total: string): RecognitionResult => ({
  status: count > 1 ? 'CONFIDENT_MULTI' : 'CONFIDENT_SINGLE', count, denominations: [50000], total: 0, formattedTotal: total, timestamp: 0,
});

describe('describeStatus', () => {
  it.each<[string, Partial<AppView>, string]>([
    ['sẵn sàng', {}, 'Đưa tiền vào trước camera'],
    ['chưa thấy tiền', { state: 'NO_CANDIDATE' }, 'Chưa thấy tiền'],
    ['một tờ chưa chắc', { state: 'UNCERTAIN', status: 'LOW_CONFIDENCE' }, 'Chưa nhận rõ tờ tiền'],
    ['đưa lại gần', { state: 'DETECTING', status: 'TOO_FAR' }, 'Đưa tiền lại gần camera hơn'],
    ['đang đọc một tờ', { state: 'SPEAKING', status: 'CONFIDENT_SINGLE', result: result(1, '50.000 đồng') }, '50.000 đồng'],
    ['đang đọc nhiều tờ', { state: 'SPEAKING', status: 'CONFIDENT_MULTI', result: result(2, '170.000 đồng') }, '2 tờ, tổng 170.000 đồng'],
    ['tờ cũ vẫn còn trước camera', { state: 'DETECTING', status: 'CONFIDENT_SINGLE', result: result(1, '50.000 đồng') }, '50.000 đồng'],
    ['Fail Safe: tiền đã rời khung thì không giữ tổng cũ', { state: 'NO_CANDIDATE', status: 'NO_MONEY_CANDIDATE', result: result(1, '50.000 đồng') }, 'Chưa thấy tiền'],
    ['Fail Safe: chưa chắc thì không hiện tổng cũ', { state: 'UNCERTAIN', status: 'LOW_CONFIDENCE', result: result(1, '50.000 đồng') }, 'Chưa nhận rõ tờ tiền'],
  ])('%s', (_name, v, expected) => expect(describeStatus(view(v))).toBe(expected));

  it('thông điệp lỗi đủ cho mọi mã, và chỉ hướng dẫn bấm nút có thật', () => {
    const messages = Object.values(ERROR_MESSAGES);
    expect(messages).toHaveLength(13);
    for (const m of messages) {
      expect(m.length).toBeGreaterThan(20);
      if (m.includes('bấm')) expect(m).toContain(`bấm ${RETRY_LABEL}`);
    }
  });
});

function setup(debug = false) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const settings = new FakeSettings();
  const guide = vi.fn();
  const ui = createAppUi({ root, settings, onReplayGuide: guide, debug });
  const actions: UiAction[] = [];
  ui.onAction((a) => actions.push(a));
  const q = <T extends HTMLElement>(selector: string): T => {
    const el = root.querySelector<T>(selector);
    if (el === null) throw new Error(`Không thấy ${selector}`);
    return el;
  };
  const visible = (): string[] => Array.from(root.children).filter((c) => !(c as HTMLElement).hidden).map((c) => c.className.replace('screen ', ''));
  return { root, settings, guide, ui, actions, q, visible };
}
const role = (r: string): string => `[data-a11y="${r}"]`;

needsP10('màn hình', () => {
  it('mỗi lúc chỉ hiện một màn', () => {
    const t = setup();
    t.ui.showSettings();
    expect(t.visible()).toEqual(['settings-screen']);
    t.ui.showError({ code: 'CAMERA_FAILED' });
    expect(t.visible()).toEqual(['error-screen']);
    t.ui.showCamera();
    expect(t.visible()).toEqual(['camera-screen']);
  });

  it('màn camera: mọi nút có nhãn riêng, video ẩn khỏi trình đọc màn hình, nút đèn chỉ có khi máy hỗ trợ', () => {
    const t = setup();
    const labels = (): string[] => Array.from(t.q('.camera-screen').querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? '');
    t.ui.setTorch({ supported: false, on: false });
    expect(labels()).toHaveLength(2);
    t.ui.setTorch({ supported: true, on: false });
    expect(labels()).toHaveLength(3);
    expect(labels().every((l) => l.length > 0) && new Set(labels()).size === 3).toBe(true);
    expect(t.q('video').getAttribute('aria-hidden')).toBe('true');
  });

  it('bấm nút gửi đúng thao tác; hủy đăng ký thì thôi nhận', () => {
    const t = setup();
    t.ui.setTorch({ supported: true, on: false });
    for (const r of ['replay', 'torch', 'settings']) t.q(role(r)).click();
    expect(t.actions).toEqual(['REPLAY', 'TOGGLE_TORCH', 'OPEN_SETTINGS']);
    const late: UiAction[] = [];
    t.ui.onAction((a) => late.push(a))();
    t.q(role('replay')).click();
    expect(late).toEqual([]);
  });

  it('vùng trạng thái hiện chữ của describeStatus', () => {
    const t = setup();
    t.ui.render(view({ state: 'NO_CANDIDATE' }));
    expect(t.q(role('status')).textContent).toBe('Chưa thấy tiền');
  });

  it('chữ trạng thái không đổi thì không ghi lại (tránh vùng aria-live bị đọc lặp mỗi khung hình)', () => {
    const t = setup();
    t.ui.render(view({ state: 'NO_CANDIDATE' }));
    const node = t.q(role('status')).firstChild;
    t.ui.render(view({ state: 'NO_CANDIDATE', reasons: ['khác'] }));
    expect(t.q(role('status')).firstChild).toBe(node);
    t.ui.render(view({ state: 'READY' }));
    expect(t.q(role('status')).textContent).toBe('Đưa tiền vào trước camera');
  });

  it('màn cài đặt: điều khiển nào cũng có nhãn, bấm là đổi cài đặt, giá trị theo dõi cài đặt đổi từ nơi khác', async () => {
    const t = setup();
    t.ui.showSettings();
    const screen = t.q('.settings-screen');
    const named = (el: Element): boolean => (el.getAttribute('aria-label') ?? el.closest('label')?.textContent ?? '').length > 0;
    expect(Array.from(screen.querySelectorAll('button, input')).every(named)).toBe(true);

    const toggle = t.q<HTMLButtonElement>('button[role="switch"]');
    const before = toggle.getAttribute('aria-checked');
    toggle.click();
    await flush();
    expect(t.settings.patches).toHaveLength(1);
    expect(toggle.getAttribute('aria-checked')).not.toBe(before);

    const radio = Array.from(screen.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) => !r.checked);
    if (radio === undefined) throw new Error('Không có lựa chọn nào đang tắt');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(t.settings.patches).toHaveLength(2);

    t.q('.settings-list > button:not([role="switch"])').click();
    expect(t.guide).toHaveBeenCalledTimes(1);
    t.q(`button[aria-label="${SETTINGS_CLOSE_LABEL}"]`).click();
    expect(t.actions).toEqual(['CLOSE_SETTINGS']);
  });

  it.each<[AppErrorCode, boolean]>([['CAMERA_IN_USE', false], ['MODEL_CORRUPT', true]])('màn lỗi %s: thông điệp, nút "Thử lại" có nhãn, chi tiết chỉ khi debug=%s', (code, debug) => {
    const t = setup(debug);
    t.ui.showError({ code, detail: 'chi tiết' });
    expect(t.q('.error-message').textContent).toBe(ERROR_MESSAGES[code]);
    expect(t.q('.error-detail').hidden).toBe(!debug);
    const retry = t.q(`button[aria-label="${RETRY_LABEL}"]`);
    retry.click();
    expect(t.actions).toEqual(['RETRY']);
  });

  it('cổng khởi động: chạm thì unlock chạy trước onStart, rồi cổng biến mất', () => {
    const t = setup();
    const calls: string[] = [];
    t.ui.showStartGate({ unlock: () => calls.push('unlock'), onStart: () => calls.push('start') });
    t.q(role('start-gate')).click();
    expect(calls).toEqual(['unlock', 'start']);
    expect(t.root.querySelector(role('start-gate'))).toBeNull();
  });

  it.each([[false], [true]])('lớp debug chỉ hiện khi có cờ (debug=%s)', (debug) => {
    const t = setup(debug);
    expect(t.root.querySelector('[data-role="debug"]') !== null).toBe(debug);
    expect(t.root.querySelector('canvas') !== null).toBe(debug);
  });
});

describe('debug-overlay', () => {
  function overlay() {
    const host = document.createElement('div');
    const panelHost = document.createElement('div');
    document.body.append(host, panelHost);
    let now = 0;
    return { overlay: createDebugOverlay({ doc: document, surface: host, panelHost, now: () => (now += 100) }), panelHost };
  }
  const frameView = (): AppView =>
    view({
      state: 'DETECTING', status: 'LOW_CONFIDENCE', reasons: ['A', 'B'],
      frame: {
        meta: { frameId: 1, width: 640, height: 480, timestamp: 0 }, detections: [], latencyMs: 12,
        timings: { preprocessMs: 1, inferMs: 2, postprocessMs: 3, totalMs: 6 }, samplingFps: 3,
      },
    });

  it('bảng hiện state, status, reasons, độ trễ từng bước và có nút tải log có nhãn', () => {
    const t = overlay();
    t.overlay.update(frameView());
    const text = t.panelHost.textContent ?? '';
    for (const part of ['state DETECTING', 'status LOW_CONFIDENCE', 'reasons A, B', 'trễ 12 ms', 'suy luận 2', 'tổng 6 ms']) expect(text).toContain(part);
    expect(t.panelHost.querySelector('button')?.getAttribute('aria-label')).toBe('Tải log JSON');
  });

  it.each<[string, [number, number], [number, number, number, number], number[]]>([
    ['canvas gấp đôi khung, không lề', [1280, 960], [100, 50, 300, 250], [200, 100, 400, 400]],
    ['canvas vuông: khung được đặt giữa, có lề trên và dưới', [1000, 1000], [0, 0, 640, 480], [0, 125, 1000, 750]],
  ])('vẽ hộp đúng chỗ trên video object-fit: contain: %s', (_name, [w, h], [x1, y1, x2, y2], expected) => {
    const host = document.createElement('div');
    document.body.append(host);
    const calls: Array<[string, number[]]> = [];
    const ctx = new Proxy({}, { get: (_t, name: string) => (...args: number[]) => void calls.push([name, args]), set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const o = createDebugOverlay({ doc: document, surface: host, panelHost: document.createElement('div'), now: () => 0 });
    const canvas = host.querySelector('canvas');
    if (canvas === null) throw new Error('Thiếu canvas');
    Object.defineProperty(canvas, 'clientWidth', { value: w });
    Object.defineProperty(canvas, 'clientHeight', { value: h });
    const det = { id: '1-0', classId: 7, denomination: 50000 as const, confidence: 0.9, bbox: { x1, y1, x2, y2 }, frameId: 1, timestamp: 0 };
    o.update({ ...frameView(), frame: { ...(frameView().frame as NonNullable<AppView['frame']>), detections: [det] } });
    vi.restoreAllMocks();
    expect(calls.find(([name]) => name === 'strokeRect')?.[1]).toEqual(expected);
    expect(calls.find(([name]) => name === 'fillText')?.[0]).toBe('fillText');
  });

  it('log JSON chỉ có số liệu (không ảnh) và giữ tối đa MAX_DEBUG_ENTRIES bản ghi', () => {
    const t = overlay();
    for (let i = 0; i < MAX_DEBUG_ENTRIES + 5; i++) t.overlay.update(frameView());
    const log = t.overlay.buildLog();
    expect(log.entries).toHaveLength(MAX_DEBUG_ENTRIES);
    expect(Object.keys(log.entries[0]?.frame ?? {})).toEqual(['latencyMs', 'samplingFps', 'timings', 'detections']);
    expect(JSON.stringify(log)).not.toMatch(/bitmap|gray|data:image/);
  });
});

needsP10('ghép createApp với giao diện thật', () => {
  it('khởi động xong thì màn camera hiện chữ theo trạng thái của engine', async () => {
    const t = makeDeps();
    t.decision.state = 'READY';
    const s = setup();
    const app = createApp({ ...t.deps, ui: s.ui });
    await app.start();
    expect(s.visible()).toEqual(['camera-screen']);
    expect(s.q(role('status')).textContent).toBe('Đưa tiền vào trước camera');
    app.dispose();
  });

  it('camera lỗi thì hiện màn lỗi; bấm "Thử lại" thì khởi động lại và về màn camera', async () => {
    const t = makeDeps({ camera: { startError: new AppError('CAMERA_PERMISSION_DENIED', 'x', true) } });
    const s = setup();
    const app = createApp({ ...t.deps, ui: s.ui });
    await app.start();
    expect(s.visible()).toEqual(['error-screen']);
    expect(s.q('.error-message').textContent).toBe(ERROR_MESSAGES.CAMERA_PERMISSION_DENIED);
    t.camera.startError = null;
    s.q(`button[aria-label="${RETRY_LABEL}"]`).click();
    await flush();
    expect(s.visible()).toEqual(['camera-screen']);
    expect(t.decision.events.filter((e) => e === 'APP_STARTED')).toHaveLength(2);
    app.dispose();
  });
});