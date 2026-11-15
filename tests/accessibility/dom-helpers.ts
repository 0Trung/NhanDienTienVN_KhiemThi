import { roleSelector } from '../../src/accessibility/a11y-shared';
import type { A11yRole } from '../../src/accessibility/a11y-shared';

export function must<T>(value: T | null | undefined, what = 'phần tử'): T {
  if (value === null || value === undefined) throw new Error(`Không tìm thấy ${what}`);
  return value;
}

/** Dọn body và thuộc tính toàn cục trên <html>, trả về một root mới nằm trong body. */
export function freshRoot(): HTMLElement {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-speech-output');
  const root = document.createElement('div');
  document.body.append(root);
  return root;
}

export const maybeByRole = (scope: ParentNode, role: A11yRole): HTMLElement | null => scope.querySelector<HTMLElement>(roleSelector(role));
export const byRole = (scope: ParentNode, role: A11yRole): HTMLElement => must(maybeByRole(scope, role), `phần tử ${role}`);
export const labelsOf = (scope: ParentNode): Array<string | null> => Array.from(scope.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));