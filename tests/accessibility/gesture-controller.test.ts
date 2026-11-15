// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGestureController } from '../../src/accessibility/gesture-controller';
import { freshRoot } from './dom-helpers';

type Step = ['down' | 'down2' | 'up' | 'cancel' | 'leave' | 'click' | 'rightDown'] | ['move' | 'wait', number];

const pointer = (type: string, init: PointerEventInit = {}): PointerEvent =>
  new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientX: 100, clientY: 100, bubbles: true, cancelable: true, ...init });

function setup() {
  const surface = freshRoot();
  const onReplay = vi.fn();
  const onToggleTorch = vi.fn();
  const controller = createGestureController({ surface, onReplay, onToggleTorch });
  const run = (steps: Step[]): [number, number] => {
    for (const step of steps) {
      const events: Record<string, () => Event> = {
        down: () => pointer('pointerdown'), down2: () => pointer('pointerdown', { pointerId: 2, isPrimary: false }),
        up: () => pointer('pointerup'), cancel: () => pointer('pointercancel'), leave: () => pointer('pointerleave'),
        rightDown: () => pointer('pointerdown', { button: 2 }), click: () => new MouseEvent('click', { bubbles: true }),
        move: () => pointer('pointermove', { clientX: 100 + (step[1] ?? 0) }),
      };
      if (step[0] === 'wait') vi.advanceTimersByTime(step[1]);
      else surface.dispatchEvent((events[step[0]] ?? (() => new Event('noop')))());
    }
    return [onReplay.mock.calls.length, onToggleTorch.mock.calls.length];
  };
  return { surface, onToggleTorch, controller, run };
}

describe('gesture-controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // [tên, các bước, số lần nghe lại, số lần bật/tắt đèn]
  const gestures: Array<[string, Step[], number, number]> = [
    ['chạm ngắn → nghe lại', [['down'], ['wait', 80], ['up']], 1, 0],
    ['giữ đủ 600 ms → bật/tắt đèn, nhả ra không nghe lại', [['down'], ['wait', 600], ['up']], 0, 1],
    ['nhả lúc 599 ms vẫn là chạm', [['down'], ['wait', 599], ['up']], 1, 0],
    ['giữ rất lâu chỉ bật đèn MỘT lần', [['down'], ['wait', 3000], ['up']], 0, 1],
    ['kéo trong ngưỡng (9 px) vẫn là chạm', [['down'], ['move', 9], ['up']], 1, 0],
    ['kéo quá ngưỡng (11 px) rồi nhả → hủy', [['down'], ['move', 11], ['up']], 0, 0],
    ['kéo quá ngưỡng trước 600 ms → không bật đèn', [['down'], ['move', 40], ['wait', 900], ['up']], 0, 0],
    ['pointercancel hoặc chuột rời bề mặt → hủy', [['down'], ['cancel'], ['down'], ['leave'], ['wait', 900], ['up']], 0, 0],
    ['có ngón thứ hai → hủy', [['down'], ['down2'], ['up'], ['wait', 900]], 0, 0],
    ['nút phụ của chuột bị bỏ qua', [['rightDown'], ['wait', 900]], 0, 0],
    // chống kích hoạt kép: sau pointerup trình duyệt còn bắn thêm click
    ['pointer rồi click đi kèm → chỉ MỘT lần', [['down'], ['up'], ['click']], 1, 0],
    ['giữ, nhả, click đi kèm → chỉ bật đèn', [['down'], ['wait', 600], ['up'], ['click']], 0, 1],
    ['kéo quá ngưỡng, nhả, click đi kèm → không gì cả', [['down'], ['move', 50], ['up'], ['click']], 0, 0],
    ['click thuần (trình đọc màn hình kích hoạt) → một lần', [['click']], 1, 0],
    ['hai lần chạm cách nhau 500 ms → hai lần', [['down'], ['up'], ['click'], ['wait', 500], ['down'], ['up'], ['click']], 2, 0],
    ['click lạc sau 401 ms kể từ lần chạm → chạm mới', [['down'], ['up'], ['wait', 401], ['click']], 2, 0],
  ];
  it.each(gestures)('%s', (_name, steps, replays, torches) => {
    expect(setup().run(steps)).toEqual([replays, torches]);
  });

  it('đèn bật đúng lúc 600 ms, không đợi nhả ngón', () => {
    const { onToggleTorch, run } = setup();
    run([['down'], ['wait', 599]]);
    expect(onToggleTorch).not.toHaveBeenCalled();
    run([['wait', 1]]);
    expect(onToggleTorch).toHaveBeenCalledTimes(1);
  });

  it('dispose gỡ lắng nghe, hủy bộ đếm giữ đang chờ, trả lại style, gọi hai lần không lỗi', () => {
    const { surface, controller, run } = setup();
    expect(surface.style.getPropertyValue('touch-action')).toBe('manipulation'); // không phóng to khi chạm đúp
    run([['down']]);
    controller.dispose();
    expect(run([['wait', 900], ['up'], ['click'], ['down'], ['up']])).toEqual([0, 0]);
    expect(surface.style.getPropertyValue('touch-action')).toBe('');
    expect(() => controller.dispose()).not.toThrow();
  });

  it('chặn menu ngữ cảnh khi giữ lâu; không dựng button nào (nút nghe lại duy nhất thuộc accessibility-manager)', () => {
    const { surface } = setup();
    const event = new Event('contextmenu', { bubbles: true, cancelable: true });
    surface.dispatchEvent(event);
    expect([event.defaultPrevented, surface.querySelectorAll('button, [role="button"]').length]).toEqual([true, 0]);
  });
});