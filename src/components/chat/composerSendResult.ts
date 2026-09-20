import type { AgentLoopDispatchResult } from '@/core/agent/agentLoopRunner';
import type { Message } from '@/types';

/** The composer restores only a draft that the dispatcher explicitly rejected. */
export function shouldRestoreComposerAfterDispatch(
  result: AgentLoopDispatchResult,
): boolean {
  return result.reason === 'error' && result.messageTaken === false;
}

/**
 * Does the transcript already explain this failure (#549)?
 *
 * A pre-accept failure stamps `runErrorKind` on the user row it failed, and
 * that row carries both the sentence and the action that resolves it. The
 * dispatcher can report the same failure either as a result or as a rejection,
 * so both paths ask this before raising a toast that would say it twice.
 */
export function failureIsOwnedByTranscript(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user' || message.isSystem) continue;
    return message.runErrorKind !== undefined;
  }
  return false;
}
