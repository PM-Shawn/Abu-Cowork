import type { IPCAdapter } from '../ports/adapters/ipc';

export class MemoryIPCAdapter implements IPCAdapter {
  private handlers = new Map<
    string,
    (payload?: Record<string, unknown>) => unknown | Promise<unknown>
  >();
  readonly calls: { command: string; payload?: Record<string, unknown> }[] = [];

  register<T = unknown>(
    command: string,
    handler: (payload?: Record<string, unknown>) => T | Promise<T>
  ): this {
    this.handlers.set(command, handler);
    return this;
  }

  async invoke<T = unknown>(
    command: string,
    payload?: Record<string, unknown>
  ): Promise<T> {
    this.calls.push({ command, payload });
    const h = this.handlers.get(command);
    if (!h) throw new Error(`IPC command not mocked: ${command}`);
    return (await h(payload)) as T;
  }

  available(command: string): boolean {
    return this.handlers.has(command);
  }
}

/** Node 端默认实现：所有命令都不可用 */
export class NoopIPCAdapter implements IPCAdapter {
  async invoke<T = unknown>(command: string): Promise<T> {
    throw new Error(`IPC not available in this runtime (command=${command})`);
  }
  available(): boolean {
    return false;
  }
}
