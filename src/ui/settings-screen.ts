/**
 * Màn Cài đặt dựng từ buildSettingsViewModel (P10): công tắc, nhóm lựa chọn, nút hành động. Mọi thay đổi đi qua hàm
 * set của view-model nên được áp dụng, lưu và xác nhận bằng giọng nói. Cập nhật TẠI CHỖ (không dựng lại DOM) để focus
 * của trình đọc màn hình không bị mất mỗi khi một giá trị đổi.
 */
import { buildSettingsViewModel } from '../accessibility/settings-view-model';
import type { ActionItem, RadioItem, SwitchItem } from '../accessibility/settings-view-model';
import type { Settings } from '../contracts';
import { createLogger } from '../utils/logger';

const log = createLogger('settings-screen');

export const SETTINGS_TITLE = 'Cài đặt';
export const SETTINGS_CLOSE_LABEL = 'Quay lại màn hình camera';

/** Phần của settings-manager mà giao diện dùng. */
export interface UiSettings {
  get(): Settings;
  set(p: Partial<Settings>): Promise<Settings>;
  subscribe(h: (s: Settings) => void): () => void;
}

interface Row {
  el: HTMLElement;
  refresh(): void;
}

export interface SettingsScreen {
  readonly el: HTMLElement;
  show(): void;
  hide(): void;
  refresh(): void;
  dispose(): void;
}

/** Lỗi bất đồng bộ của hàm đổi cài đặt chỉ được ghi log, không làm hỏng giao diện. */
const fire = (p: Promise<unknown>): void => void p.catch((e: unknown) => log.warn('Đổi cài đặt lỗi', e));

export function createSettingsScreen(o: { doc: Document; settings: UiSettings; onReplayGuide: () => void; onClose: () => void }): SettingsScreen {
  const { doc } = o;
  const items = buildSettingsViewModel(() => o.settings.get(), (p) => o.settings.set(p), { onReplayGuide: o.onReplayGuide });
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /** Công tắc: nhãn nằm ở aria-label, trạng thái ở aria-checked; chữ "Bật/Tắt" hiện cho mắt nên bị ẩn khỏi trình đọc. */
  function switchRow(item: SwitchItem): Row {
    const button = make('button', 'btn');
    button.type = 'button';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-label', item.label);
    const state = make('span');
    state.setAttribute('aria-hidden', 'true');
    button.append(make('span', undefined, item.label), state);
    button.addEventListener('click', () => fire(item.toggle()));
    return {
      el: button,
      refresh: () => {
        button.setAttribute('aria-checked', String(item.value));
        state.textContent = item.valueText;
      },
    };
  }

  function radioRow(item: RadioItem): Row {
    const group = make('fieldset', 'setting');
    group.append(make('legend', undefined, item.label));
    const inputs = item.options.map((option) => {
      const label = make('label', 'choice');
      const input = make('input');
      input.type = 'radio';
      input.name = `setting-${item.id}`;
      input.value = option.value;
      input.addEventListener('change', () => {
        if (input.checked) fire(item.set(option.value));
      });
      label.append(input, make('span', undefined, option.label));
      group.append(label);
      return input;
    });
    return { el: group, refresh: () => inputs.forEach((input) => void (input.checked = input.value === item.value)) };
  }

  function actionRow(item: ActionItem): Row {
    const button = make('button', 'btn', item.label);
    button.type = 'button';
    button.setAttribute('aria-label', item.label);
    button.addEventListener('click', () => item.run());
    return { el: button, refresh: () => undefined };
  }

  const el = make('section', 'screen settings-screen');
  el.hidden = true;
  el.setAttribute('aria-labelledby', 'settings-title');
  const title = make('h1', undefined, SETTINGS_TITLE);
  title.id = 'settings-title';
  title.tabIndex = -1;
  const close = make('button', 'btn btn-primary', SETTINGS_CLOSE_LABEL);
  close.type = 'button';
  close.setAttribute('aria-label', SETTINGS_CLOSE_LABEL);
  close.addEventListener('click', o.onClose);
  const rows = items.map((item) => (item.kind === 'switch' ? switchRow(item) : item.kind === 'radio' ? radioRow(item) : actionRow(item)));
  const list = make('div', 'settings-list');
  list.append(...rows.map((row) => row.el));
  el.append(title, close, list);

  const refresh = (): void => rows.forEach((row) => row.refresh());
  refresh();
  const unsubscribe = o.settings.subscribe(refresh);

  return {
    el,
    refresh,
    show() {
      refresh();
      el.hidden = false;
      title.focus({ preventScroll: true }); // trình đọc màn hình đọc "Cài đặt" khi màn mở
    },
    hide: () => void (el.hidden = true),
    dispose() {
      unsubscribe();
      el.remove();
    },
  };
}