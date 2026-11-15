// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { createStartGate, START_GATE_LABEL } from '../../src/accessibility/start-gate';
import { setLogSink } from '../../src/utils/logger';
import { byRole, freshRoot, maybeByRole } from './dom-helpers';

function setup(unlock?: () => void) {
  const root = freshRoot();
  const replay = document.createElement('button');
  replay.setAttribute('data-a11y', 'replay');
  const other = document.createElement('div');
  root.append(replay, other);
  const calls: string[] = [];
  const gate = createStartGate({ root, onStart: () => calls.push('onStart'), unlock: unlock ?? (() => calls.push('unlock')) });
  const button = (): HTMLElement => byRole(root, 'start-gate');
  const strayFocus = (): HTMLElement => {
    const el = document.createElement('button');
    root.append(el);
    el.focus();
    return el;
  };
  return { root, replay, other, calls, gate, button, strayFocus };
}

describe('start-gate', () => {
  beforeEach(() => setLogSink(() => undefined));

  it('show dựng đúng MỘT button toàn màn hình, nhãn đầy đủ, đầu root, có focus', () => {
    const { root, gate, button } = setup();
    gate.show();
    gate.show();
    expect(root.querySelectorAll('[data-a11y="start-gate"]')).toHaveLength(1);
    expect([button().tagName, button().getAttribute('aria-label')]).toEqual(['BUTTON', 'Bắt đầu nhận dạng tiền. Chạm hai lần để bắt đầu.']);
    expect(START_GATE_LABEL).toBe(button().getAttribute('aria-label'));
    expect(['position', 'width', 'height'].map((p) => button().style.getPropertyValue(p))).toEqual(['fixed', '100%', '100%']);
    expect([root.firstElementChild, document.activeElement]).toEqual([button(), button()]);
  });

  it('click gọi unlock TRƯỚC onStart, ngay trong sự kiện; chỉ chạy một lần; show sau đó không hiện lại', () => {
    const { root, calls, gate, button } = setup();
    gate.show();
    const first = button();
    first.click();
    first.click();
    gate.show();
    expect(calls).toEqual(['unlock', 'onStart']);
    expect(maybeByRole(root, 'start-gate')).toBeNull();
  });

  it.each([false, true])('kích hoạt gỡ cổng và chuyển focus sang nút nghe lại (focus đã lạc: %s)', (stray) => {
    const { root, replay, gate, button, strayFocus } = setup();
    gate.show();
    if (stray) strayFocus();
    button().click();
    expect(maybeByRole(root, 'start-gate')).toBeNull();
    expect(document.activeElement).toBe(replay);
  });

  it('hide không qua kích hoạt: không giật focus, không gọi callback', () => {
    const { root, calls, gate, strayFocus } = setup();
    gate.show();
    const stray = strayFocus();
    gate.hide();
    expect([document.activeElement, maybeByRole(root, 'start-gate'), calls]).toEqual([stray, null, []]);
  });

  it('cổng hiện thì phần còn lại bị inert (trừ vùng aria-live), ẩn thì trả lại', () => {
    const { root, other, replay, gate } = setup();
    const live = document.createElement('div');
    live.setAttribute('aria-live', 'assertive');
    root.append(live);
    gate.show();
    expect([other, replay, live].map((el) => el.hasAttribute('inert'))).toEqual([true, true, false]);
    gate.hide();
    expect([other, replay, live].map((el) => el.hasAttribute('inert'))).toEqual([false, false, false]);
  });

  it('unlock ném lỗi vẫn gọi onStart để không kẹt ở cổng', () => {
    const { calls, gate, button } = setup(() => {
      throw new Error('boom');
    });
    gate.show();
    button().click();
    expect(calls).toEqual(['onStart']);
  });

  it.each(['pointerdown', 'touchstart', 'mousedown'])('%s KHÔNG kích hoạt cổng (chỉ click qua được TalkBack/VoiceOver)', (type) => {
    const { calls, gate, button } = setup();
    gate.show();
    button().dispatchEvent(new Event(type, { bubbles: true }));
    expect(calls).toEqual([]);
  });
});