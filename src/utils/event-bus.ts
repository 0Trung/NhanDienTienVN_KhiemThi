import { createLogger } from './logger';

const log = createLogger('event-bus');

type StoredHandler = (payload: unknown) => void;
interface Entry { readonly handler: StoredHandler }

export interface EventBus<E extends Record<string, unknown>> {
  on<K extends keyof E>(k: K, h: (p: E[K]) => void): () => void;
  off<K extends keyof E>(k: K, h: (p: E[K]) => void): void;
  emit<K extends keyof E>(k: K, p: E[K]): void;
}

/**
 * Bus sự kiện nhỏ, có kiểu theo bản đồ sự kiện E.
 * - on trả về hàm hủy đăng ký.
 * - Lỗi ném ra trong một handler được ghi log và KHÔNG ảnh hưởng handler khác.
 * - emit duyệt trên bản chụp danh sách, nên handler tự hủy trong lúc emit không làm mất handler kế tiếp.
 */
export function createEventBus<E extends Record<string, unknown>>(): EventBus<E> {
  const registry = new Map<keyof E, Entry[]>();

  function removeEntry(key: keyof E, entry: Entry): void {
    const list = registry.get(key);
    if (!list) return;
    const index = list.indexOf(entry);
    if (index === -1) return;
    list.splice(index, 1);
    if (list.length === 0) registry.delete(key);
  }

  function on<K extends keyof E>(k: K, h: (p: E[K]) => void): () => void {
    const entry: Entry = { handler: h as StoredHandler };
    const list = registry.get(k);
    if (list) list.push(entry);
    else registry.set(k, [entry]);
    return () => removeEntry(k, entry);
  }

  function off<K extends keyof E>(k: K, h: (p: E[K]) => void): void {
    const list = registry.get(k);
    const entry = list?.find((e) => e.handler === (h as StoredHandler));
    if (entry) removeEntry(k, entry);
  }

  function emit<K extends keyof E>(k: K, p: E[K]): void {
    const list = registry.get(k);
    if (!list || list.length === 0) return;
    for (const entry of list.slice()) {
      try {
        entry.handler(p);
      } catch (err) {
        log.error(`Handler của sự kiện "${String(k)}" ném lỗi`, err);
      }
    }
  }

  return { on, off, emit };
}