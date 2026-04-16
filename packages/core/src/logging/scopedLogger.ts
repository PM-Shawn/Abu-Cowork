import type { LoggerAdapter } from '../ports/adapters/logger';

export interface ScopedLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/**
 * 模块级 logger 语法糖。还原 Abu 原版的 `createLogger('xxx').info(...)` API。
 *
 * 示例：
 * ```ts
 * const log = scopedLogger(adapter, 'agentLoop');
 * log.info('started', { conversationId });
 * ```
 */
export function scopedLogger(adapter: LoggerAdapter, module: string): ScopedLogger {
  return {
    debug: (m, d) => adapter.log('debug', module, m, d),
    info: (m, d) => adapter.log('info', module, m, d),
    warn: (m, d) => adapter.log('warn', module, m, d),
    error: (m, d) => adapter.log('error', module, m, d),
  };
}
