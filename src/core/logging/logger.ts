/**
 * Structured Logger — lightweight ring-buffer logger for Abu desktop app.
 *
 * - In-memory ring buffer (500 entries) for all levels
 * - Disk persistence for warn/error (Tauri appDataDir/logs/)
 * - Daily rotation, keeps last 7 days
 * - Console passthrough for all levels
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

// ── Disk persistence (warn/error only) ──

const DISK_LOG_LEVELS: Set<LogLevel> = new Set(['warn', 'error']);
const LOG_RETENTION_DAYS = 7;
let logDirPath: string | null = null;
let diskWriteQueue: string[] = [];
let flushScheduled = false;

/** Lazy-init log directory path (only resolved once, async) */
async function getLogDir(): Promise<string> {
  if (logDirPath) return logDirPath;
  try {
    const { appDataDir } = await import('@tauri-apps/api/path');
    const { mkdir, exists } = await import('@tauri-apps/plugin-fs');
    const base = await appDataDir();
    logDirPath = `${base}logs`;
    if (!await exists(logDirPath)) {
      await mkdir(logDirPath, { recursive: true });
    }
    return logDirPath;
  } catch {
    logDirPath = null;
    return '';
  }
}

function getTodayFileName(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
}

function formatEntryForDisk(entry: LogEntry): string {
  const time = new Date(entry.timestamp).toISOString();
  const dataStr = entry.data ? ' ' + JSON.stringify(entry.data) : '';
  return `${time} [${entry.level.toUpperCase()}] [${entry.module}] ${entry.message}${dataStr}`;
}

/** Batch-flush queued log lines to disk (debounced to avoid excessive I/O) */
async function flushToDisk(): Promise<void> {
  flushScheduled = false;
  if (diskWriteQueue.length === 0) return;
  const lines = diskWriteQueue.join('\n') + '\n';
  diskWriteQueue = [];
  try {
    const dir = await getLogDir();
    if (!dir) return;
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const filePath = `${dir}/${getTodayFileName()}`;
    await writeTextFile(filePath, lines, { append: true });
  } catch {
    // Disk write failed — silently drop (don't block the app)
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(flushToDisk, 500); // batch writes within 500ms
}

function writeToDiskIfNeeded(entry: LogEntry): void {
  if (!DISK_LOG_LEVELS.has(entry.level)) return;
  diskWriteQueue.push(formatEntryForDisk(entry));
  scheduleFlush();
}

/** Clean up log files older than LOG_RETENTION_DAYS. Call once on app start. */
async function cleanupOldLogs(): Promise<void> {
  try {
    const dir = await getLogDir();
    if (!dir) return;
    const { readDir, remove } = await import('@tauri-apps/plugin-fs');
    const entries = await readDir(dir);
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.name?.endsWith('.log')) continue;
      // Parse date from filename: YYYY-MM-DD.log
      const match = entry.name.match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
      if (!match) continue;
      const fileDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
      if (fileDate < cutoff) {
        await remove(`${dir}/${entry.name}`).catch(() => {});
      }
    }
  } catch {
    // Non-critical
  }
}

// Fire-and-forget cleanup on module load
void cleanupOldLogs();

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
    writeToDiskIfNeeded(entry);
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
