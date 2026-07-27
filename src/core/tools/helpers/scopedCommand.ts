import { invoke } from '@tauri-apps/api/core';
import type { ToolExecutionContext } from '../../../types';

export class TaskCommandAbortedError extends Error {
  constructor() {
    super('command was aborted before it started');
    this.name = 'TaskCommandAbortedError';
  }
}

export function isTaskCommandAbortedError(err: unknown): err is TaskCommandAbortedError {
  return err instanceof TaskCommandAbortedError;
}

function makeCommandId(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

/**
 * Electron exposes the renderer marker from preload; its sidecar runs through
 * Electron-as-Node. Tauri has neither signal, so its locked invoke argument
 * contract stays unchanged.
 */
export function hasElectronCommandHost(): boolean {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    process?: { env?: Record<string, string | undefined> };
  };
  return (
    runtime.__ABU_SHELL__?.mainSupervisesSidecar === true ||
    runtime.process?.env?.ELECTRON_RUN_AS_NODE === '1'
  );
}

export async function invokeTaskCommand<T>(
  cmd: 'run_shell_command' | 'run_argv_command',
  args: Record<string, unknown>,
  context?: ToolExecutionContext,
  options?: {
    commandIdPrefix?: string;
    keepAbortListenerAfterResolve?: (result: T) => boolean;
  },
): Promise<T> {
  const abortSignal = context?.abortSignal;
  if (abortSignal?.aborted) {
    throw new TaskCommandAbortedError();
  }

  const commandId = hasElectronCommandHost()
    ? makeCommandId(options?.commandIdPrefix ?? 'task-command')
    : undefined;
  let keepAbortListener = false;

  const abortCommand = () => {
    if (commandId) invoke('abort_command', { commandId }).catch(() => {});
    abortSignal?.removeEventListener('abort', abortCommand);
  };

  if (commandId) abortSignal?.addEventListener('abort', abortCommand, { once: true });

  try {
    const result = await invoke<T>(cmd, {
      ...(commandId ? { commandId } : {}),
      ...args,
    });
    keepAbortListener = options?.keepAbortListenerAfterResolve?.(result) === true;
    return result;
  } finally {
    if (!keepAbortListener) {
      abortSignal?.removeEventListener('abort', abortCommand);
    }
  }
}
