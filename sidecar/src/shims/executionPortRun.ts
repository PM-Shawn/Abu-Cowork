/**
 * Sidecar-local replacement for `src/core/agent/ports/executionPort.ts`.
 *
 * REAL behavior shim, same reasoning as `chatDeltaRun.ts` — `agentLoop.ts`
 * and `plannedStepsPrompt.ts` call `getExecutionPort()` BARE, no
 * options-injection field exists for it. Resolves the current run's
 * `ExecutionPort` (a `createFrameExecutionPort(push)` from
 * `portFrameSenders.ts`, augmented with the plannedSteps-patch mirror — see
 * `agentLoopHost.ts`) from the ambient `agentRunContext`.
 *
 * `applyExecutionWithId` (the real module's shell-side id-preserving apply
 * seam for `frameApplier.ts`) is deliberately NOT re-exported here — nothing
 * reachable from `sidecar/src/main.ts`'s bundle graph imports it by name
 * (it is a SHELL-side-only helper, consumed by `frameApplier.ts`, which
 * never runs in the sidecar).
 */
import type { ExecutionPort } from '@/core/agent/ports/executionPort';
import { getCurrentAgentRunContext } from '../agentRunContext';

export function getExecutionPort(): ExecutionPort {
  return getCurrentAgentRunContext().executionPort;
}

export function setExecutionPort(_port: ExecutionPort): void {
  throw new Error(
    '[sidecar] setExecutionPort() called inside the sidecar bundle — executionPort is injected per-run via agentRunContext.run(), never slot-swapped. This indicates a wiring bug.',
  );
}
