/**
 * Sidecar-local replacement for `src/core/agent/ports/scratchpadPort.ts`.
 *
 * REAL behavior shim — `agentLoop.ts`'s `createEventRouter` call threads
 * `getScratchpadPort().addEntry` in as `addScratchpadEntry`. Resolves the
 * current run's `ScratchpadPort` (a `createFrameScratchpadPort(push)` from
 * `portFrameSenders.ts`) from the ambient `agentRunContext`.
 *
 * `applyScratchpadEntryWithId` (the real module's shell-side id-preserving
 * apply seam) is deliberately not re-exported — shell-only, consumed by
 * `frameApplier.ts`, never reachable from the sidecar bundle.
 */
import type { ScratchpadPort } from '@/core/agent/ports/scratchpadPort';
import { getCurrentAgentRunContext } from '../agentRunContext';

export function getScratchpadPort(): ScratchpadPort {
  return getCurrentAgentRunContext().scratchpadPort;
}

export function setScratchpadPort(_port: ScratchpadPort): void {
  throw new Error(
    '[sidecar] setScratchpadPort() called inside the sidecar bundle — scratchpadPort is injected per-run via agentRunContext.run(), never slot-swapped. This indicates a wiring bug.',
  );
}
