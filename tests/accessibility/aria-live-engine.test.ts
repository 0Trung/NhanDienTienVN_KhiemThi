// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_SPEECH_MS, REWRITE_DELAY_MS, createAriaLiveEngine, estimateSpeechMs } from '../../src/accessibility/aria-live-engine';
import { setLogSink } from '../../src/utils/logger';
import { byRole, freshRoot } from './dom-helpers';

const OPTS = { rate: 1, lang: 'vi-VN' };
const makeHooks = () => ({ onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() });

async function setup() {
  const root = freshRoot();
  const engine = createAriaLiveEngine({ root });
  await engine.init();
  return { engine, hooks: makeHooks(), region: (): HTMLElement => byRole(root, 'live-region') };
}

describe('aria-live-engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setLogSink(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    setLogSink(null);
  });

  it('tên engine và năng lực khai báo', async () => {
    const { engine } = await setup();
    expect(engine.name).toBe('aria-live');
    expect(await engine.init()).toEqual({ available: true, vietnameseVoice: true, offlineVietnamese: true, requiresUserGesture: false });
  });

  it('vùng aria-live assertive ẩn bằng clip, KHÔNG dùng display:none, visibility:hidden hay aria-hidden', async () => {
    const el = (await setup()).region();
    expect([el.getAttribute('aria-live'), el.getAttribute('aria-atomic'), el.style.getPropertyValue('width')]).toEqual(['assertive', 'true', '1px']);
    expect(el.style.getPropertyValue('clip')).not.toBe('');
    expect([el.style.getPropertyValue('display'), el.style.getPropertyValue('visibility'), el.hasAttribute('aria-hidden')]).toEqual(['', '', false]);
  });

  it('speak xóa vùng rồi ghi chữ sau một nhịp ngắn, đặt lang theo opts.lang', async () => {
    const { engine, hooks, region } = await setup();
    engine.speak('Hai mươi nghìn đồng', OPTS, hooks);
    expect([region().textContent, region().getAttribute('lang')]).toEqual(['', 'vi-VN']);
    vi.advanceTimersByTime(REWRITE_DELAY_MS - 1);
    expect(region().textContent).toBe('');
    vi.advanceTimersByTime(1);
    expect(region().textContent).toBe('Hai mươi nghìn đồng');
  });

  it('câu giống hệt câu trước vẫn được ghi lại (xóa rồi ghi lại)', async () => {
    const { engine, hooks, region } = await setup();
    engine.speak('Năm mươi nghìn đồng', OPTS, hooks);
    vi.advanceTimersByTime(REWRITE_DELAY_MS);
    engine.speak('Năm mươi nghìn đồng', OPTS, hooks);
    expect(region().textContent).toBe(''); // bị xóa → lần ghi sau là một thay đổi thật
    vi.advanceTimersByTime(REWRITE_DELAY_MS);
    expect(region().textContent).toBe('Năm mươi nghìn đồng');
  });

  // [tên, văn bản, rate, mili giây mong đợi]
  const estimates: Array<[string, string, number, number]> = [
    ['câu ngắn lấy mức tối thiểu', 'ok', 1, MIN_SPEECH_MS],
    ['70 ms mỗi ký tự ở rate 1', 'a'.repeat(20), 1, 1400],
    ['rate 2 chia đôi thời gian', 'a'.repeat(40), 2, 1400],
    ['rate 2 vẫn không dưới mức tối thiểu', 'a'.repeat(10), 2, MIN_SPEECH_MS],
    ['rate 0.8 kéo dài thời gian', 'a'.repeat(40), 0.8, 3500],
    ['rate 0 coi như 1', 'a'.repeat(20), 0, 1400],
    ['rate NaN coi như 1', 'a'.repeat(20), Number.NaN, 1400],
  ];
  it.each(estimates)('estimateSpeechMs: %s', (_name, text, rate, expected) => {
    expect(estimateSpeechMs(text, rate)).toBeCloseTo(expected, 5);
  });

  it('onStart gọi ngay một lần; onEnd bắn đúng một lần, đúng lúc ước lượng và chia theo rate của câu', async () => {
    const { engine, hooks } = await setup();
    engine.speak('a'.repeat(40), { rate: 2, lang: 'vi-VN' }, hooks); // 2800 / 2 = 1400 ms
    expect(hooks.onStart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1399);
    expect(hooks.onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(60_000);
    expect([hooks.onEnd.mock.calls.length, hooks.onError.mock.calls.length]).toEqual([1, 0]);
  });

  it('câu mới thay câu cũ: hook của câu cũ không được gọi; câu cũ không bao giờ lọt vào vùng', async () => {
    const { engine, region } = await setup();
    const [first, second] = [makeHooks(), makeHooks()];
    engine.speak('Câu cũ', OPTS, first);
    vi.advanceTimersByTime(REWRITE_DELAY_MS / 2);
    engine.speak('Câu mới', OPTS, second);
    vi.advanceTimersByTime(REWRITE_DELAY_MS / 2); // đúng lúc lẽ ra câu cũ được ghi
    expect(region().textContent).toBe('');
    vi.advanceTimersByTime(60_000);
    expect([first.onEnd.mock.calls.length, second.onEnd.mock.calls.length, region().textContent]).toEqual([0, 1, 'Câu mới']);
  });

  it.each([0, REWRITE_DELAY_MS])('cancel sau %s ms: xóa vùng, không onEnd/onError, chữ không "sống lại"', async (after) => {
    const { engine, hooks, region } = await setup();
    engine.speak('Xin chào', OPTS, hooks);
    vi.advanceTimersByTime(after);
    engine.cancel();
    vi.advanceTimersByTime(60_000);
    expect([region().textContent, hooks.onEnd.mock.calls.length, hooks.onError.mock.calls.length]).toEqual(['', 0, 0]);
  });

  it('hook ném lỗi không làm hỏng engine', async () => {
    const { engine, region } = await setup();
    const hooks = { ...makeHooks(), onStart: vi.fn(() => { throw new Error('boom'); }) };
    expect(() => engine.speak('Xin chào', OPTS, hooks)).not.toThrow();
    vi.advanceTimersByTime(MIN_SPEECH_MS);
    expect([hooks.onEnd.mock.calls.length, region().textContent]).toEqual([1, 'Xin chào']);
  });
});