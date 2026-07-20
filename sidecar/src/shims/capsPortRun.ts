/**
 * Sidecar-local replacement for `src/core/agent/ports/capsPort.ts`.
 *
 * P1-3B-3A REWORK (same reasoning as `toolInvokerRun.ts` — see that file):
 * `agentLoop.ts` has no `capsPort` option field; its bare
 * `getCapsPort().get(...)`/`.record*(...)` calls are always reached on the
 * main-loop path. Resolves the current run's `CapsPort` (per-run snapshot +
 * `caps.record` notification forwarder, constructed by `agentLoopHost.ts` —
 * see design doc §3 "capsPort" row: "入口快照 + caps.record 通知 + 本地回声")
 * from the ambient `agentRunContext`. Subagent code still resolves its own
 * `SubagentLoopOptions.capsPort` first (unchanged, P1-3a), so it never
 * reaches this bare getter.
 */
import type { CapsPort } from '@/core/agent/ports/capsPort';
import { getCurrentAgentRunContext } from '../agentRunContext';

export function getCapsPort(): CapsPort {
  return getCurrentAgentRunContext().capsPort;
}

export function setCapsPort(_port: CapsPort): void {
  throw new Error(
    '[sidecar] setCapsPort() called inside the sidecar bundle — capsPort is injected per-run via agentRunContext.run(), never slot-swapped. This indicates a wiring bug.',
  );
}
