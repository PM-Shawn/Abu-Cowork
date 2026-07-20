/**
 * Sidecar-local replacement for `src/core/agent/ports/abortRegistry.ts`.
 *
 * REAL behavior shim — `agentLoop.ts` calls `getAbortRegistry()` bare at
 * entry (the concurrency guard + the `clearAbortController`/
 * `getAbortController` trio). Per the design doc §3 "abortRegistry" row,
 * abort signals do NOT cross the process boundary (3a discipline unchanged):
 * `agentLoopHost.ts` constructs a per-run LOCAL `Map<conversationId,
 * AbortController>`-backed registry (lazily creating controllers, same
 * contract as the in-process store's `getAbortController`) — a real, live
 * `AbortController` whose `.signal` the loop threads into its own fetch/tool
 * calls, aborted when the shell sends `agent.abort {runId}`.
 */
import type { AbortRegistry } from '@/core/agent/ports/abortRegistry';
import { getCurrentAgentRunContext } from '../agentRunContext';

export function getAbortRegistry(): AbortRegistry {
  return getCurrentAgentRunContext().abortRegistry;
}

export function setAbortRegistry(_registry: AbortRegistry): void {
  throw new Error(
    '[sidecar] setAbortRegistry() called inside the sidecar bundle — abortRegistry is injected per-run via agentRunContext.run(), never slot-swapped. This indicates a wiring bug.',
  );
}
