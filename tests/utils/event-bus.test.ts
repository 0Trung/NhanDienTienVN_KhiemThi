import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../../src/utils/event-bus';
import { clearRecentLogs, getRecentLogs, setLogLevel, setLogSink } from '../../src/utils/logger';

type Events = { ping: number; text: string };

describe('createEventBus', () => {
  beforeEach(() => {
    setLogLevel('debug');
    setLogSink(() => undefined);
    clearRecentLogs();
  });

  it('emit gọi handler với đúng payload', () => {
    const bus = createEventBus<Events>();
    const handler = vi.fn();
    bus.on('ping', handler);
    bus.emit('ping', 7);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(7);
  });

  it('nhiều handler cùng sự kiện đều được gọi theo thứ tự đăng ký', () => {
    const bus = createEventBus<Events>();
    const order: string[] = [];
    bus.on('ping', () => order.push('a'));
    bus.on('ping', () => order.push('b'));
    bus.emit('ping', 1);
    expect(order).toEqual(['a', 'b']);
  });

  it('hàm hủy do on trả về ngừng gọi handler', () => {
    const bus = createEventBus<Events>();
    const handler = vi.fn();
    const unsubscribe = bus.on('ping', handler);
    bus.emit('ping', 1);
    unsubscribe();
    bus.emit('ping', 2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('off gỡ đúng handler được chỉ định', () => {
    const bus = createEventBus<Events>();
    const keep = vi.fn();
    const drop = vi.fn();
    bus.on('ping', keep);
    bus.on('ping', drop);
    bus.off('ping', drop);
    bus.emit('ping', 1);
    expect(keep).toHaveBeenCalledTimes(1);
    expect(drop).not.toHaveBeenCalled();
  });

  it('emit sự kiện chưa có handler không ném lỗi', () => {
    const bus = createEventBus<Events>();
    expect(() => bus.emit('text', 'xin chào')).not.toThrow();
  });

  it('lỗi trong một handler không làm hỏng handler khác', () => {
    const bus = createEventBus<Events>();
    const after = vi.fn();
    bus.on('ping', () => {
      throw new Error('boom');
    });
    bus.on('ping', after);
    expect(() => bus.emit('ping', 5)).not.toThrow();
    expect(after).toHaveBeenCalledWith(5);
  });

  it('lỗi của handler được ghi vào log', () => {
    const bus = createEventBus<Events>();
    bus.on('ping', () => {
      throw new Error('boom');
    });
    bus.emit('ping', 1);
    expect(getRecentLogs().some((line) => line.includes('event-bus') && line.includes('boom'))).toBe(true);
  });

  it('handler tự hủy trong lúc emit không làm mất handler kế tiếp', () => {
    const bus = createEventBus<Events>();
    const second = vi.fn();
    const unsubscribeFirst = bus.on('ping', () => unsubscribeFirst());
    bus.on('ping', second);
    bus.emit('ping', 1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('các sự kiện khác nhau độc lập với nhau', () => {
    const bus = createEventBus<Events>();
    const onPing = vi.fn();
    const onText = vi.fn();
    bus.on('ping', onPing);
    bus.on('text', onText);
    bus.emit('text', 'a');
    expect(onPing).not.toHaveBeenCalled();
    expect(onText).toHaveBeenCalledWith('a');
  });
});