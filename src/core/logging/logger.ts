/**
 * Structured Logger — lightweight ring-buffer logger for Abu desktop app.
 *
 * No external dependencies. Stores the last N entries in memory and
 * passes each log call through to the corresponding console.* method.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

interface LogFilter {
  module?: string;
  level?: LogLevel;
  since?: number;
}

// ── Ring buffer ──

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];
let writeIndex = 0;
let entryCount = 0;

function pushEntry(entry: LogEntry): void {
  if (entryCount < MAX_ENTRIES) {
    buffer.push(entry);
    entryCount++;
  } else {
    buffer[writeIndex] = entry;
  }
  writeIndex = (writeIndex + 1) % MAX_ENTRIES;
}

// ── Console passthrough ──

const consoleMethods: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

// ── Public API ──

/**
 * Create a logger scoped to a module name.
 *
 * ```ts
 * const logger = createLogger('agentLoop');
 * logger.info('Agent loop started', { conversationId });
 * ```
 */
function createLogger(module: string): Logger {
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    const entry: LogEntry = { level, module, message, timestamp: Date.now(), ...(data !== undefined ? { data } : {}) };
    pushEntry(entry);
    const prefix = `[${module}]`;
    if (data) {
      consoleMethods[level](prefix, message, data);
    } else {
      consoleMethods[level](prefix, message);
    }
  };

  return {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),
  };
}

/**
 * Retrieve recent log entries, optionally filtered by module, level, or timestamp.
 */
function getRecentLogs(filter?: LogFilter): LogEntry[] {
  // Read entries in chronological order from the ring buffer
  const result: LogEntry[] = [];
  const total = Math.min(entryCount, MAX_ENTRIES);
  const start = entryCount < MAX_ENTRIES ? 0 : writeIndex;

  for (let i = 0; i < total; i++) {
    const entry = buffer[(start + i) % MAX_ENTRIES];
    if (filter?.module && entry.module !== filter.module) continue;
    if (filter?.level && entry.level !== filter.level) continue;
    if (filter?.since && entry.timestamp < filter.since) continue;
    result.push(entry);
  }
  return result;
}

/**
 * Clear all log entries from the ring buffer.
 */
function clearLogs(): void {
  buffer.length = 0;
  writeIndex = 0;
  entryCount = 0;
}

export { createLogger, getRecentLogs, clearLogs };
export type { LogLevel, LogEntry, Logger, LogFilter };
