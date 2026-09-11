/**
 * Sidecar replacement for `src/core/tools/helpers/taskCommandInvoke.ts`.
 *
 * AbortSignal listeners run in the async context that calls `abort()`, not
 * the context that registered the listener. Capture the current owner while
 * a command is being registered and explicitly re-enter it for every later
 * native call, including the out-of-band `abort_command` cleanup callback.
 */
import { agentRunContext } from '../agentRunContext';
import { subagentRunContext } from '../subagentRunContext';
import { invoke, invokeCleanupForCapturedRun } from './tauriCoreInvokeRun';

type TaskCommandInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export function captureTaskCommandInvoke(runIdHint?: string): TaskCommandInvoke {
  const agentContext = agentRunContext.getStore();
  if (agentContext) {
    return <T>(cmd: string, args?: Record<string, unknown>) => (
      agentRunContext.run(agentContext, () => invoke<T>(cmd, args))
    );
  }

  const subagentContext = subagentRunContext.getStore();
  if (subagentContext) {
    return <T>(cmd: string, args?: Record<string, unknown>) => (
      subagentRunContext.run(subagentContext, () => invoke<T>(cmd, args))
    );
  }

  return <T>(cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'abort_command' && runIdHint) {
      return invokeCleanupForCapturedRun<T>(runIdHint, cmd, args);
    }
    return invoke<T>(cmd, args);
  };
}
