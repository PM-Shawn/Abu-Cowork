import type {
  LoggerAdapter,
  LogEntry,
  LogLevel,
} from '../ports/adapters/logger';
import type { ClockAdapter } from '../ports/adapters/clock';

export interface RingBufferLoggerOptions {
  capacity?: number;
  /** 可选：某些级别的日志同时转发到该函数（如 Tauri/Node 的磁盘持久化） */
  sink?: (entry: LogEntry) => void;
  /** 可选：控制哪些级别转发到 sink（默认 warn/error） */
  sinkLevels?: LogLevel[];
  /** 可选：同时 console.X 透传（调试用） */
  echoConsole?: boolean;
}

/**
 * RingBufferLoggerAdapter —— 从 Abu 原版 logger.ts 抽出的平台无关核心：
 * - 固定容量环形缓冲（默认 500）
 * - 可选 sink 回调（磁盘持久化由 shell 端注入，不在 core 中）
 * - 可选 console 透传
 *
 * 零平台依赖，Tauri 和 Node 共用。
 */
export class RingBufferLoggerAdapter implements LoggerAdapter {
  private buffer: LogEntry[] = [];
  private writeIndex = 0;
  private entryCount = 0;
  private readonly capacity: number;
  private readonly sink?: (entry: LogEntry) => void;
  private readonly sinkLevels: Set<LogLevel>;
  private readonly echoConsole: boolean;

  constructor(
    private readonly clock: ClockAdapter,
    opts: RingBufferLoggerOptions = {}
  ) {
    this.capacity = opts.capacity ?? 500;
    this.sink = opts.sink;
    this.sinkLevels = new Set(opts.sinkLevels ?? ['warn', 'error']);
    this.echoConsole = !!opts.echoConsole;
  }

  log(level: LogLevel, module: string, message: string, data?: unknown): void {
    const entry: LogEntry = {
      ts: this.clock.now(),
      level,
      module,
      message,
      ...(data !== undefined ? { data } : {}),
    };

    if (this.entryCount < this.capacity) {
      this.buffer.push(entry);
      this.entryCount++;
    } else {
      this.buffer[this.writeIndex] = entry;
    }
    this.writeIndex = (this.writeIndex + 1) % this.capacity;

    if (this.echoConsole) {
      const prefix = `[${module}]`;
      const fn = console[level] ?? console.log;
      if (data !== undefined) fn.call(console, prefix, message, data);
      else fn.call(console, prefix, message);
    }

    if (this.sink && this.sinkLevels.has(level)) {
      try {
        this.sink(entry);
      } catch {
        /* sink must not block logging */
      }
    }
  }

  getRecent(limit?: number): LogEntry[] {
    const result: LogEntry[] = [];
    const total = Math.min(this.entryCount, this.capacity);
    const start = this.entryCount < this.capacity ? 0 : this.writeIndex;
    for (let i = 0; i < total; i++) {
      result.push(this.buffer[(start + i) % this.capacity]);
    }
    return limit != null ? result.slice(-limit) : result;
  }

  async flush(): Promise<void> {
    /* ring buffer 是内存结构；磁盘 sink 由调用方自己保证写入 */
  }

  clear(): void {
    this.buffer = [];
    this.writeIndex = 0;
    this.entryCount = 0;
  }
}
