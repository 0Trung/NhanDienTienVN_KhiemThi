/**
 * Logger dùng chung. Mức log chỉnh được; bộ đệm vòng giữ 200 dòng gần nhất để xem khi gỡ lỗi.
 * Mặc định: bản production chỉ ghi warn và error, bản dev ghi từ debug.
 * Mức log áp dụng cho cả bộ đệm lẫn nơi in ra. Không chạm DOM nên dùng được trong Web Worker.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Nơi nhận dòng log đã định dạng. Mặc định là console. */
export type LogSink = (level: LogLevel, line: string) => void;

export interface Logger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LINES = 200;
const MAX_LINE_LENGTH = 1000;

function defaultLevel(): LogLevel {
  try {
    return import.meta.env?.PROD === true ? 'warn' : 'debug';
  } catch {
    return 'warn';
  }
}

function consoleSink(level: LogLevel, line: string): void {
  console[level](line);
}

let currentLevel: LogLevel = defaultLevel();
let sink: LogSink = consoleSink;
const buffer: string[] = [];

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === 'object' && a !== null) {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

function write(scope: string, level: LogLevel, args: unknown[]): void {
  if (RANK[level] < RANK[currentLevel]) return;
  let line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${args.map(formatArg).join(' ')}`;
  if (line.length > MAX_LINE_LENGTH) line = `${line.slice(0, MAX_LINE_LENGTH)}…`;
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  try {
    sink(level, line);
  } catch {
    // Lỗi của nơi nhận log không được làm hỏng luồng chính.
  }
}

/** Tạo logger gắn với một phạm vi (tên module). */
export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => write(scope, 'debug', a),
    info: (...a) => write(scope, 'info', a),
    warn: (...a) => write(scope, 'warn', a),
    error: (...a) => write(scope, 'error', a),
  };
}

/** Các dòng log gần nhất (tối đa 200), cũ trước, mới sau. */
export function getRecentLogs(): string[] {
  return buffer.slice();
}

/** Đổi mức log tối thiểu được ghi. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Thay nơi nhận log (dùng khi test); truyền null để quay về console. */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? consoleSink;
}

/** Xóa bộ đệm log. */
export function clearRecentLogs(): void {
  buffer.length = 0;
}