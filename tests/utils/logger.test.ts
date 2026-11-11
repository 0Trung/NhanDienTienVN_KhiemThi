import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecentLogs,
  createLogger,
  getLogLevel,
  getRecentLogs,
  setLogLevel,
  setLogSink,
} from '../../src/utils/logger';
import type { LogLevel } from '../../src/utils/logger';

describe('logger', () => {
  beforeEach(() => {
    setLogLevel('debug');
    setLogSink(() => undefined);
    clearRecentLogs();
  });

  it('ghi dòng có mức và phạm vi vào bộ đệm', () => {
    createLogger('demo').info('xin chào', 42);
    const lines = getRecentLogs();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('INFO [demo] xin chào 42');
  });

  it.each([
    { level: 'debug', expected: ['debug', 'info', 'warn', 'error'] },
    { level: 'info', expected: ['info', 'warn', 'error'] },
    { level: 'warn', expected: ['warn', 'error'] },
    { level: 'error', expected: ['error'] },
  ] as Array<{ level: LogLevel; expected: LogLevel[] }>)('mức %s lọc đúng các dòng được ghi', ({ level, expected }) => {
    const received: LogLevel[] = [];
    setLogSink((l) => received.push(l));
    setLogLevel(level);
    const log = createLogger('filter');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(received).toEqual(expected);
    expect(getRecentLogs()).toHaveLength(expected.length);
  });

  it('setLogLevel đổi được mức và getLogLevel trả lại đúng giá trị', () => {
    setLogLevel('error');
    expect(getLogLevel()).toBe('error');
  });

  it('bộ đệm chỉ giữ 200 dòng mới nhất', () => {
    const log = createLogger('ring');
    for (let i = 0; i < 250; i++) log.info(`dòng ${i}`);
    const lines = getRecentLogs();
    expect(lines).toHaveLength(200);
    expect(lines[0]?.endsWith('dòng 50')).toBe(true);
    expect(lines[199]?.endsWith('dòng 249')).toBe(true);
  });

  it('getRecentLogs trả bản sao, sửa bản sao không ảnh hưởng bộ đệm', () => {
    createLogger('copy').info('một');
    getRecentLogs().length = 0;
    expect(getRecentLogs()).toHaveLength(1);
  });

  it('lỗi trong nơi nhận log không làm hỏng logger', () => {
    setLogSink(() => {
      throw new Error('sink hỏng');
    });
    expect(() => createLogger('safe').error('vẫn chạy')).not.toThrow();
    expect(getRecentLogs()).toHaveLength(1);
  });

  it('định dạng được Error, object và undefined', () => {
    createLogger('fmt').warn(new Error('hỏng'), { a: 1 }, undefined);
    const line = getRecentLogs()[0] ?? '';
    expect(line).toContain('Error: hỏng');
    expect(line).toContain('{"a":1}');
    expect(line).toContain('undefined');
  });
});