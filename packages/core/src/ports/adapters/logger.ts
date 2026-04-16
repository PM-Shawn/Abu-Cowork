export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
}

export interface LoggerAdapter {
  log(level: LogLevel, module: string, message: string, data?: unknown): void;
  getRecent(limit?: number): LogEntry[];
  flush(): Promise<void>;
}
