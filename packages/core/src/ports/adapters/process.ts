import type { UnwatchFn } from './storage';

export interface ChildProcessHandle {
  pid: number;
  write(data: string | Uint8Array): Promise<void>;
  onStdout(handler: (chunk: string) => void): UnwatchFn;
  onStderr(handler: (chunk: string) => void): UnwatchFn;
  onExit(handler: (code: number | null) => void): UnwatchFn;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

export interface SpawnConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ProcessAdapter {
  spawn(cfg: SpawnConfig): Promise<ChildProcessHandle>;
}
