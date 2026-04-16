import type {
  ProcessAdapter,
  ChildProcessHandle,
  SpawnConfig,
} from '../ports/adapters/process';
import type { UnwatchFn } from '../ports/adapters/storage';

type StdoutHandler = (chunk: string) => void;
type ExitHandler = (code: number | null) => void;

export type ScriptedProcess = (handle: {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  exit(code: number | null): void;
  onStdin(handler: (data: string) => void): void;
}) => void | Promise<void>;

export class MemoryProcessAdapter implements ProcessAdapter {
  private scripts = new Map<string, ScriptedProcess>();
  readonly spawned: { cfg: SpawnConfig }[] = [];

  register(commandPattern: string, script: ScriptedProcess): this {
    this.scripts.set(commandPattern, script);
    return this;
  }

  async spawn(cfg: SpawnConfig): Promise<ChildProcessHandle> {
    this.spawned.push({ cfg });
    const stdoutHandlers = new Set<StdoutHandler>();
    const stderrHandlers = new Set<StdoutHandler>();
    const exitHandlers = new Set<ExitHandler>();
    let stdinHandler: ((d: string) => void) | undefined;
    let alive = true;
    const pid = Math.floor(Math.random() * 100000) + 1000;

    const script = this.scripts.get(cfg.command);
    if (script) {
      queueMicrotask(() =>
        script({
          stdout: (c) => stdoutHandlers.forEach((h) => h(c)),
          stderr: (c) => stderrHandlers.forEach((h) => h(c)),
          exit: (code) => {
            alive = false;
            exitHandlers.forEach((h) => h(code));
          },
          onStdin: (h) => (stdinHandler = h),
        })
      );
    }

    const sub = <T>(set: Set<T>, h: T): UnwatchFn => {
      set.add(h);
      return () => set.delete(h);
    };

    return {
      pid,
      async write(data) {
        if (!alive) throw new Error('process exited');
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        stdinHandler?.(text);
      },
      onStdout: (h) => sub(stdoutHandlers, h),
      onStderr: (h) => sub(stderrHandlers, h),
      onExit: (h) => sub(exitHandlers, h),
      async kill() {
        if (!alive) return;
        alive = false;
        exitHandlers.forEach((h) => h(null));
      },
    };
  }
}
