import type {
  LoggerAdapter,
  LogEntry,
  LogLevel,
} from '../ports/adapters/logger';
import type { ClockAdapter } from '../ports/adapters/clock';

/**
 * ConsoleLoggerAdapter —— 只打 console 的最小实现。
 * 用途：Node 开发模式、CLI 脚本、单测时简单跟踪。
 * 不做环形缓冲；getRecent 返回空。
 */
export class ConsoleLoggerAdapter implements LoggerAdapter {
  constructor(private readonly clock: ClockAdapter) {}

  log(level: LogLevel, module: string, message: string, data?: unknown): void {
    const ts = new Date(this.clock.now()).toISOString();
    const prefix = `${ts} [${level.toUpperCase()}] [${module}]`;
    const fn = console[level] ?? console.log;
    if (data !== undefined) fn.call(console, prefix, message, data);
    else fn.call(console, prefix, message);
  }

  getRecent(_limit?: number): LogEntry[] {
    return [];
  }

  async flush(): Promise<void> {
    /* no-op */
  }
}
