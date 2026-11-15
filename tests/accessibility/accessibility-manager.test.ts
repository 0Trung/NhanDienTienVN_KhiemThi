// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createAccessibilityManager } from '../../src/accessibility/accessibility-manager';
import { createGestureController } from '../../src/accessibility/gesture-controller';
import type { A11yRole } from '../../src/accessibility/a11y-shared';
import { byRole, freshRoot, labelsOf, maybeByRole } from './dom-helpers';

const buttons: Array<[A11yRole, string]> = [['replay', 'Nghe lại kết quả'], ['torch', 'Bật đèn'], ['settings', 'Cài đặt']];
const ALL = buttons.map(([, label]) => label);
const WITHOUT_TORCH = ['Nghe lại kết quả', 'Cài đặt'];
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
const setOutput = (mode: string): void => document.documentElement.setAttribute('data-speech-output', mode);

function setup(torchSupported = true) {
  const root = freshRoot();
  const cb = { onReplay: vi.fn(), onToggleTorch: vi.fn(), onOpenSettings: vi.fn() };
  const manager = createAccessibilityManager({ root, torchSupported, ...cb });
  return { root, cb, manager, status: () => byRole(root, 'status') };
}

describe('accessibility-manager', () => {
  it.each(buttons)('nút %s: button thật, nhãn "%s", tối thiểu 48 × 48 px', (role, label) => {
    const button = byRole(setup().root, role);
    expect([button.tagName, button.getAttribute('type'), button.getAttribute('aria-label')]).toEqual(['BUTTON', 'button', label]);
    expect([button.style.getPropertyValue('min-height'), button.style.getPropertyValue('min-width')]).toEqual(['48px', '48px']);
  });

  it('thứ tự focus cố định Nghe lại → Bật đèn → Cài đặt, và nút Nghe lại đứng đầu dù root đã có nút khác', () => {
    expect(labelsOf(setup().root)).toEqual(ALL);
    const root = freshRoot();
    root.append(document.createElement('button'));
    createAccessibilityManager({ root, torchSupported: true, onReplay: vi.fn(), onToggleTorch: vi.fn(), onOpenSettings: vi.fn() });
    expect(root.querySelector('button')?.getAttribute('aria-label')).toBe('Nghe lại kết quả');
  });

  it('không hỗ trợ đèn thì nút đèn không có trong DOM; setTorchSupported thêm/bớt mà vẫn giữ thứ tự', () => {
    const { root, manager } = setup(false);
    expect([maybeByRole(root, 'torch'), labelsOf(root)]).toEqual([null, WITHOUT_TORCH]);
    manager.setTorchSupported(true);
    manager.setTorchSupported(true);
    expect(labelsOf(root)).toEqual(ALL);
    manager.setTorchSupported(false);
    expect(labelsOf(root)).toEqual(WITHOUT_TORCH);
  });

  it('aria-pressed phản ánh trạng thái THẬT do P11 báo (bấm nút không tự đổi)', () => {
    const { root, manager } = setup();
    const torch = byRole(root, 'torch');
    torch.click();
    const states = [torch.getAttribute('aria-pressed')];
    manager.setTorchPressed(true);
    states.push(torch.getAttribute('aria-pressed'));
    manager.setTorchPressed(false);
    states.push(torch.getAttribute('aria-pressed'));
    expect(states).toEqual(['false', 'true', 'false']);
  });

  it('trạng thái đèn có chữ và biểu tượng hình khác nhau (không chỉ màu); phần trang trí ẩn khỏi trình đọc màn hình', () => {
    const { root, manager } = setup();
    const torch = byRole(root, 'torch');
    expect([torch.textContent?.includes('Đang tắt'), torch.textContent?.includes('○')]).toEqual([true, true]);
    manager.setTorchPressed(true);
    expect([torch.textContent?.includes('Đang bật'), torch.textContent?.includes('●')]).toEqual([true, true]);
    expect(torch.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });

  it.each(buttons)('click nút %s chỉ gọi đúng callback của nó', (role) => {
    const { root, cb } = setup();
    byRole(root, role).click();
    expect({ replay: cb.onReplay.mock.calls.length, torch: cb.onToggleTorch.mock.calls.length, settings: cb.onOpenSettings.mock.calls.length })
      .toEqual({ replay: 0, torch: 0, settings: 0, [role]: 1 });
  });

  it('focusReplay đưa focus về nút Nghe lại kết quả', () => {
    const { root, manager } = setup();
    byRole(root, 'settings').focus();
    manager.focusReplay();
    expect(document.activeElement).toBe(byRole(root, 'replay'));
  });

  it('đặt lang vi cho html và tiêu đề trang', () => {
    document.documentElement.setAttribute('lang', 'en');
    setup();
    expect([document.documentElement.getAttribute('lang'), document.title]).toEqual(['vi', 'Nhận dạng tiền']);
  });

  it('vùng trạng thái mặc định aria-hidden, KHÔNG aria-live (tránh đọc đè lên giọng của app)', () => {
    const { manager, status } = setup();
    manager.setStatusText('Đang tìm tiền');
    expect([status().textContent, status().getAttribute('aria-hidden'), status().hasAttribute('aria-live')]).toEqual(['Đang tìm tiền', 'true', false]);
  });

  it('chỉ khi speechOutput là SCREEN_READER vùng trạng thái mới là aria-live, đổi lại thì ẩn lại', async () => {
    const { status } = setup();
    setOutput('SCREEN_READER');
    await tick(); // theo dõi thuộc tính: áp dụng ngay cả khi chưa ai ghi chữ
    expect([status().getAttribute('aria-live'), status().hasAttribute('aria-hidden')]).toEqual(['polite', false]);
    setOutput('APP_TTS');
    await tick();
    expect([status().getAttribute('aria-hidden'), status().hasAttribute('aria-live')]).toEqual(['true', false]);
  });

  it('dispose gỡ cụm và vùng trạng thái, gọi lại không lỗi, không thêm nút lại', () => {
    const { root, manager } = setup(false);
    manager.dispose();
    expect(() => manager.dispose()).not.toThrow();
    manager.setTorchSupported(true);
    expect(root.children).toHaveLength(0);
  });

  it('ghép gesture-controller: dựng hai lần vẫn đúng MỘT nút Nghe lại kết quả; nút và chạm bề mặt cùng gọi onReplay', () => {
    const root = freshRoot();
    const surface = document.createElement('div');
    root.append(surface);
    const onReplay = vi.fn();
    for (let i = 0; i < 2; i += 1) createAccessibilityManager({ root, torchSupported: true, onReplay, onToggleTorch: vi.fn(), onOpenSettings: vi.fn() });
    createGestureController({ surface, onReplay, onToggleTorch: vi.fn() });
    expect(document.querySelectorAll('[aria-label="Nghe lại kết quả"]')).toHaveLength(1);
    byRole(root, 'replay').click();
    surface.click();
    expect(onReplay).toHaveBeenCalledTimes(2);
  });
});