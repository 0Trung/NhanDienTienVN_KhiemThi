import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HapticEvent, IHaptics } from '../../src/contracts';
import { clearRecentLogs, setLogSink } from '../../src/utils/logger';
import { createHaptics, createHapticService, HAPTIC_PATTERNS } from '../../src/voice/haptic-service';
import type { HapticPort, HapticTimers, WebVibrate } from '../../src/voice/haptic-service';

/** Hẹn giờ giả: thời gian chỉ trôi khi gọi advance. */
class FakeTimers implements HapticTimers {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; run: () => void }>();

  get pendingCount(): number {
    return this.tasks.size;
  }

  setTimeout(run: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, run });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.tasks].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].run();
    }
    this.now = target;
  }
}

type PortMode = 'ok' | 'false' | 'reject' | 'throw';
interface Pulse { atMs: number; durationMs: number }

/** Cổng rung giả: ghi từng nhịp kèm thời điểm; modeOf(i) quyết định nhịp thứ i thành công hay lỗi kiểu nào. */
class FakePort implements HapticPort {
  readonly pulses: Pulse[] = [];

  constructor(
    private readonly clock: () => number,
    private readonly modeOf: (callIndex: number) => PortMode,
  ) {}

  vibrate(durationMs: number): Promise<boolean> {
    const mode = this.modeOf(this.pulses.length);
    this.pulses.push({ atMs: this.clock(), durationMs });
    if (mode === 'throw') throw new Error('port ném đồng bộ');
    if (mode === 'reject') return Promise.reject(new Error('port từ chối'));
    return Promise.resolve(mode === 'ok');
  }
}

interface Env {
  timers: FakeTimers;
  port: FakePort | null;
  web: number[][];
  service: IHaptics;
  setEnabled(on: boolean): void;
}

function setup(o: { port?: boolean | ((i: number) => PortMode); web?: boolean } = {}): Env {
  const timers = new FakeTimers();
  const port = o.port ? new FakePort(() => timers.now, typeof o.port === 'function' ? o.port : () => 'ok') : null;
  const web: number[][] = [];
  const webVibrate: WebVibrate | null = o.web
    ? (pattern) => {
        web.push(pattern);
        return true;
      }
    : null;
  let enabled = true;
  const service = createHapticService({ isEnabled: () => enabled, port, webVibrate, timers });
  return {
    timers, port, web, service,
    setEnabled: (on) => {
      enabled = on;
    },
  };
}

/** Cho các promise đang chờ chạy xong (kết quả của port được xử lý bất đồng bộ). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => setLogSink(() => undefined));
afterEach(() => {
  setLogSink(null);
  clearRecentLogs();
});

describe('mẫu rung', () => {
  it('khớp đặc tả', () => {
    expect(HAPTIC_PATTERNS).toEqual({ START: [30], SUCCESS: [40, 60, 40], UNCERTAIN: [300], ERROR: [100, 80, 100, 80, 300] });
  });
});

describe('native qua port: chuỗi nhịp phát bằng hẹn giờ', () => {
  it.each<[HapticEvent, Pulse[]]>([
    ['START', [{ atMs: 0, durationMs: 30 }]],
    ['SUCCESS', [{ atMs: 0, durationMs: 40 }, { atMs: 100, durationMs: 40 }]],
    ['UNCERTAIN', [{ atMs: 0, durationMs: 300 }]],
    ['ERROR', [{ atMs: 0, durationMs: 100 }, { atMs: 180, durationMs: 100 }, { atMs: 360, durationMs: 300 }]],
  ])('%s', async (event, pulses) => {
    const env = setup({ port: true, web: true });
    env.service.play(event);
    env.timers.advance(1000);
    await settle();
    expect(env.port?.pulses).toEqual(pulses);
    expect(env.web).toEqual([]); // có port thì không dùng navigator.vibrate
  });

  it('nhịp đầu rung ngay, các nhịp sau chờ hẹn giờ', () => {
    const env = setup({ port: true });
    env.service.play('ERROR');
    expect(env.port?.pulses).toEqual([{ atMs: 0, durationMs: 100 }]);
    expect(env.timers.pendingCount).toBe(2);
  });
});

describe('dự phòng navigator.vibrate khi không có port', () => {
  it.each(Object.entries(HAPTIC_PATTERNS) as Array<[HapticEvent, number[]]>)('%s: gọi một lần với cả mẫu', (event, pattern) => {
    const env = setup({ web: true });
    env.service.play(event);
    expect(env.web).toEqual([pattern]);
    expect(env.timers.pendingCount).toBe(0);
  });

  it('không đưa mảng gốc cho trình duyệt', () => {
    const env = setup({ web: true });
    env.service.play('START');
    env.web[0]?.push(999);
    expect(HAPTIC_PATTERNS.START).toEqual([30]);
  });
});

describe('supported', () => {
  it.each<[string, boolean, boolean, boolean]>([
    ['chỉ có port', true, false, true],
    ['chỉ có navigator.vibrate', false, true, true],
    ['không có gì', false, false, false],
  ])('%s → %s', (_label, port, web, supported) => {
    expect(setup({ port, web }).service.supported).toBe(supported);
  });

  it('không có gì thì play không làm gì và không ném lỗi', () => {
    const env = setup();
    expect(() => env.service.play('ERROR')).not.toThrow();
    expect(env.timers.pendingCount).toBe(0);
  });
});

describe('tôn trọng cài đặt rung', () => {
  it('tắt rung thì không rung (native lẫn navigator.vibrate), bật lại thì rung', async () => {
    const native = setup({ port: true });
    const web = setup({ web: true });
    for (const env of [native, web]) env.setEnabled(false);
    native.service.play('SUCCESS');
    web.service.play('SUCCESS');
    native.timers.advance(1000);
    await settle();
    expect(native.port?.pulses).toEqual([]);
    expect(web.web).toEqual([]);

    web.setEnabled(true);
    web.service.play('START');
    expect(web.web).toEqual([[30]]);
  });

  it('tắt rung giữa chừng một chuỗi thì các nhịp còn lại bị bỏ', async () => {
    const env = setup({ port: true });
    env.service.play('ERROR');
    env.timers.advance(100);
    env.setEnabled(false);
    env.timers.advance(1000);
    await settle();
    expect(env.port?.pulses).toEqual([{ atMs: 0, durationMs: 100 }]);
  });

  it('isEnabled ném lỗi thì coi như đã tắt, không ném ra ngoài', () => {
    const timers = new FakeTimers();
    const port = new FakePort(() => timers.now, () => 'ok');
    const isEnabled = (): boolean => {
      throw new Error('kho cài đặt hỏng');
    };
    const service = createHapticService({ isEnabled, port, timers });
    expect(() => service.play('START')).not.toThrow();
    expect(port.pulses).toEqual([]);
  });
});

describe('chuỗi mới hủy chuỗi cũ', () => {
  it('ERROR đang chạy bị START thay thế: hẹn giờ cũ bị hủy, nhịp cũ không bao giờ phát', async () => {
    const env = setup({ port: true });
    env.service.play('ERROR');
    env.timers.advance(100);
    expect(env.timers.pendingCount).toBe(2);
    env.service.play('START');
    expect(env.timers.pendingCount).toBe(0);
    env.timers.advance(2000);
    await settle();
    expect(env.port?.pulses).toEqual([{ atMs: 0, durationMs: 100 }, { atMs: 100, durationMs: 30 }]);
  });

  it('navigator.vibrate: hai lần play gọi theo thứ tự (trình duyệt tự hủy mẫu cũ)', () => {
    const env = setup({ web: true });
    env.service.play('ERROR');
    env.service.play('START');
    expect(env.web).toEqual([[100, 80, 100, 80, 300], [30]]);
  });
});

describe('plugin native lỗi', () => {
  it.each<[string, PortMode]>([
    ['trả false', 'false'],
    ['từ chối (reject)', 'reject'],
    ['ném đồng bộ', 'throw'],
  ])('%s → chuyển sang navigator.vibrate, các lần sau không gọi port nữa', async (_label, mode) => {
    const env = setup({ port: () => mode, web: true });
    env.service.play('SUCCESS');
    await settle();
    expect(env.web).toEqual([[40, 60, 40]]);
    expect(env.service.supported).toBe(true);
    env.service.play('START');
    expect(env.web).toEqual([[40, 60, 40], [30]]);
    expect(env.port?.pulses).toHaveLength(1);
  });

  it('không có dự phòng thì supported thành false và play không làm gì thêm', async () => {
    const env = setup({ port: () => 'reject' });
    expect(env.service.supported).toBe(true);
    env.service.play('START');
    await settle();
    expect(env.service.supported).toBe(false);
    env.service.play('START');
    expect(env.port?.pulses).toHaveLength(1);
  });

  it('nhịp giữa chừng lỗi thì chỉ rung nốt phần còn lại bằng navigator.vibrate', async () => {
    const env = setup({ port: (i) => (i === 2 ? 'false' : 'ok'), web: true });
    env.service.play('ERROR');
    env.timers.advance(1000);
    await settle();
    expect(env.port?.pulses).toHaveLength(3);
    expect(env.web).toEqual([[300]]);
  });

  it('lỗi về muộn của chuỗi cũ không làm hỏng chuỗi mới', async () => {
    const env = setup({ port: () => 'false', web: true });
    env.service.play('ERROR');
    env.service.play('START'); // thay ngay trước khi kết quả lỗi của ERROR kịp về
    await settle();
    expect(env.web).toEqual([[30]]);
  });
});

describe('createHaptics (bản thật) trong Node', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const stubNavigator = (value: unknown): void => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  };

  afterEach(() => {
    if (original !== undefined) Object.defineProperty(globalThis, 'navigator', original);
    else delete (globalThis as unknown as Record<string, unknown>)['navigator'];
  });

  it('không có Capacitor native và không có navigator.vibrate → supported false, play không ném lỗi', () => {
    stubNavigator({});
    const haptics = createHaptics({ isEnabled: () => true });
    expect(haptics.supported).toBe(false);
    expect(() => haptics.play('SUCCESS')).not.toThrow();
  });

  it('có navigator.vibrate → dùng nó với cả mẫu rung, và tôn trọng cài đặt', () => {
    const calls: unknown[] = [];
    stubNavigator({
      vibrate: (pattern: unknown) => {
        calls.push(pattern);
        return true;
      },
    });
    let enabled = true;
    const haptics = createHaptics({ isEnabled: () => enabled });
    expect(haptics.supported).toBe(true);
    haptics.play('UNCERTAIN');
    enabled = false;
    haptics.play('ERROR');
    expect(calls).toEqual([[300]]);
  });
});