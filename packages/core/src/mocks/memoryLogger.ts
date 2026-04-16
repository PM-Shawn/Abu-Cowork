import type {
  LoggerAdapter,
  LogEntry,
  LogLevel,
} from '../ports/adapters/logger';

export class MemoryLoggerAdapter implements LoggerAdapter {
  readonly entries: LogEntry[] = [];
  private capacity: number;

  constructor(capacity = 1000) {
    this.capacity = capacity;
  }

  log(level: LogLevel, module: string, message: string, data?: unknown): void {
    this.entries.push({ ts: Date.now(), level, module, message, data });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  getRecent(limit?: number): LogEntry[] {
    if (limit == null) return [...this.entries];
    return this.entries.slice(-limit);
  }

  async flush(): Promise<void> {
    /* no-op */
  }
}
