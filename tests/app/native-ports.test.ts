import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppLifecyclePort } from '../../src/app/app-lifecycle-adapter';
import type { AppPluginLike, LifecycleDocument } from '../../src/app/app-lifecycle-adapter';
import { createNativeTorchPort } from '../../src/app/native-torch';
import { setLogSink } from '../../src/utils/logger';
import { flush } from './app-fakes';

beforeAll(() => setLogSink(() => undefined));
afterAll(() => setLogSink(null));

/** Plugin @capacitor/app giả: addListener bất đồng bộ như plugin thật. */
function fakePlugin(o: { registerFails?: boolean; minimizeFails?: boolean } = {}) {
  const listeners = new Map<string, (e: unknown) => void>();
  const removed: string[] = [];
  let minimized = 0;
  const plugin = {
    async addListener(name: string, cb: (e: unknown) => void) {
      if (o.registerFails) throw new Error('plugin thiếu');
      listeners.set(name, cb);
      return { remove: async () => void (listeners.delete(name), removed.push(name)) };
    },
    async minimizeApp() {
      if (o.minimizeFails) throw new Error('unimplemented');
      minimized += 1;
    },
  } as unknown as AppPluginLike;
  return { plugin, listeners, removed, get minimized() { return minimized; } };
}

function fakeDoc(): LifecycleDocument & { state: string; fire(): void; count: number } {
  const set = new Set<() => void>();
  return {
    state: 'visible',
    get visibilityState() { return this.state; },
    addEventListener: (_t, l) => void set.add(l),
    removeEventListener: (_t, l) => void set.delete(l),
    fire() { for (const l of [...set]) l(); },
    get count() { return set.size; },
  };
}

describe('createAppLifecyclePort', () => {
  it('nghe cả visibilitychange lẫn appStateChange', async () => {
    const doc = fakeDoc();
    const p = fakePlugin();
    const seen: boolean[] = [];
    createAppLifecyclePort({ doc, plugin: p.plugin }).onVisibilityChange((v) => seen.push(v));
    await flush();
    doc.state = 'hidden';
    doc.fire();
    p.listeners.get('appStateChange')?.({ isActive: true });
    doc.state = 'visible';
    doc.fire();
    expect(seen).toEqual([false, true, true]);
  });

  it('gỡ trước khi plugin đăng ký xong vẫn gỡ được, và gỡ cả listener của document', async () => {
    const doc = fakeDoc();
    const p = fakePlugin();
    const off = createAppLifecyclePort({ doc, plugin: p.plugin }).onVisibilityChange(() => undefined);
    off();
    await flush();
    expect(p.removed).toEqual(['appStateChange']);
    expect(p.listeners.size).toBe(0);
    expect(doc.count).toBe(0);
  });

  it('nút Back gọi handler và gỡ được', async () => {
    const p = fakePlugin();
    let backs = 0;
    const off = createAppLifecyclePort({ doc: null, plugin: p.plugin }).onBackButton(() => (backs += 1));
    await flush();
    p.listeners.get('backButton')?.({ canGoBack: false });
    off();
    await flush();
    expect(backs).toBe(1);
    expect(p.removed).toEqual(['backButton']);
  });

  it('minimize gọi minimizeApp; plugin lỗi hoặc không có thì không ném', async () => {
    const ok = fakePlugin();
    await createAppLifecyclePort({ doc: null, plugin: ok.plugin }).minimize();
    expect(ok.minimized).toBe(1);
    await expect(createAppLifecyclePort({ doc: null, plugin: fakePlugin({ minimizeFails: true }).plugin }).minimize()).resolves.toBeUndefined();
    await expect(createAppLifecyclePort({ doc: null, plugin: null }).minimize()).resolves.toBeUndefined();
  });

  it('plugin không đăng ký được listener thì không ném; document vẫn hoạt động', async () => {
    const doc = fakeDoc();
    const seen: boolean[] = [];
    const port = createAppLifecyclePort({ doc, plugin: fakePlugin({ registerFails: true }).plugin });
    port.onVisibilityChange((v) => seen.push(v));
    port.onBackButton(() => undefined)();
    await flush();
    doc.state = 'hidden';
    doc.fire();
    expect(seen).toEqual([false]);
  });
});

describe('createNativeTorchPort', () => {
  it('chưa cài plugin đèn: báo không hỗ trợ và không bao giờ bật được', async () => {
    const port = createNativeTorchPort();
    await expect(port.isSupported()).resolves.toBe(false);
    await expect(port.set(true)).resolves.toBe(false);
    await expect(port.set(false)).resolves.toBe(false);
  });
});