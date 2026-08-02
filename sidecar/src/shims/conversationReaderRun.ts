/**
 * Sidecar-local replacement for `src/core/agent/ports/conversationReader.ts`.
 *
 * REAL behavior shim, same reasoning as `chatDeltaRun.ts` — `agentLoop.ts`
 * (and `toolExecutor.ts`, `plannedStepsPrompt.ts`) call `getConversationReader()`
 * BARE dozens of times, no options-injection field exists for it. Resolves
 * the current run's `ConversationReader` (the conversation run-mirror, see
 * `sidecar/src/conversationRunMirror.ts`) from the ambient `agentRunContext`.
 */
import type { ConversationReader } from '@/core/agent/ports/conversationReader';
import { getCurrentAgentRunContext } from '../agentRunContext';

export function getConversationReader(): ConversationReader {
  return getCurrentAgentRunContext().conversationReader;
}

export function setConversationReader(_reader: ConversationReader): void {
  throw new Error(
    '[sidecar] setConversationReader() called inside the sidecar bundle — conversationReader is injected per-run via agentRunContext.run(), never slot-swapped. This indicates a wiring bug.',
  );
}
