import { describe, expect, it } from 'vitest';
import { createFakeClock, systemClock } from '../../src/utils/time';

describe('createFakeClock', () => {
  it('mặc định bắt đầu từ 0', () => {
    expect(createFakeClock().now()).toBe(0);
  });

  it('bắt đầu từ giá trị start', () => {
    expect(createFakeClock(1500).now()).toBe(1500);
  });

  it('advance cộng dồn thời gian', () => {
    const clock = createFakeClock(100);
    clock.advance(50);
    clock.advance(25);
    expect(clock.now()).toBe(175);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('advance(%s) ném RangeError', (ms) => {
    expect(() => createFakeClock().advance(ms)).toThrow(RangeError);
  });
});

describe('systemClock', () => {
  it('không đi lùi giữa hai lần gọi', () => {
    const a = systemClock();
    const b = systemClock();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});