import type { ToolExecutionContext } from '@/types';
import { createLogger } from '@/core/logging/logger';
import { hasElectronCommandHost } from '@/utils/electronHost';
import { captureTaskCommandInvoke } from '@/core/tools/helpers/taskCommandInvoke';

export { hasElectronCommandHost } from '@/utils/electronHost';

const logger = createLogger('scoped-command');

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

  const taskInvoke = captureTaskCommandInvoke(context?.loopId);
  const commandId = hasElectronCommandHost()
    ? makeCommandId(options?.commandIdPrefix ?? 'task-command')
    : undefined;
  let keepAbortListener = false;

  const abortCommand = () => {
    if (commandId) {
      taskInvoke('abort_command', { commandId }).catch((error: unknown) => {
        logger.warn('abort_command dispatch failed', {
          commandId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    abortSignal?.removeEventListener('abort', abortCommand);
  };

  if (commandId) abortSignal?.addEventListener('abort', abortCommand, { once: true });

  try {
    const result = await taskInvoke<T>(cmd, {
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
