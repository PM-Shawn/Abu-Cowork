import type { AgentLoopDispatchResult } from '@/core/agent/agentLoopRunner';

/** The composer restores only a draft that the dispatcher explicitly rejected. */
export function shouldRestoreComposerAfterDispatch(
  result: AgentLoopDispatchResult,
): boolean {
  return result.reason === 'error' && result.messageTaken === false;
}
