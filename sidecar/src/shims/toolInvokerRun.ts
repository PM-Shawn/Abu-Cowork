/**
 * Sidecar-local replacement for `src/core/agent/ports/toolInvoker.ts`.
 *
 * P1-3B-3A REWORK: this used to be a pure bundle-graph-only THROWING shim
 * (P1-3a) — correct at the time, because `subagentLoop.ts`'s
 * `options.toolInvoker ?? getToolInvoker()` fallback is provably never
 * taken (`subagentHost.ts` always injects a per-run reverse-RPC
 * `ToolInvoker` into `SubagentLoopOptions` — unchanged by this batch, still
 * true). But `agentLoop.ts` (the MAIN loop, new to the sidecar this batch)
 * has NO `toolInvoker` field on `AgentLoopOptions` at all — its
 * `const toolInvoker = getToolInvoker();` call (entry, plus
 * `toolExecutor.ts`'s own bare call) is genuinely, always reached on every
 * sidecar-run main loop. So `getToolInvoker()` now resolves the CURRENT
 * run's `ToolInvoker` from the ambient `agentRunContext` (P1-3B-3A item 2)
 * — a reverse `tool.invoke`-backed invoker, same shape as `subagentHost.ts`'s
 * `createReverseToolInvoker`, constructed per-run by `agentLoopHost.ts`.
 *
 * Both paths keep working correctly: subagent code (whether run via
 * `subagentHost.ts`'s OWN top-level `subagent.run` RPC, or via
 * `subagentRunner.ts`'s in-sidecar `runSubagent()` shim nested inside a
 * main-loop run — see that shim) ALWAYS resolves `toolInvoker` from its own
 * injected `SubagentLoopOptions.toolInvoker` FIRST, so it never reaches this
 * module's bare getter at all — this file's real implementation is only
 * ever exercised by the main loop's bare call.
 *
 * If `getToolInvoker()` is ever reached OUTSIDE an active `agentRunContext`
 * scope, `getCurrentAgentRunContext()` throws loudly (wiring-bug signal),
 * same "escalate cleanly" discipline the old throwing default used.
 */
import type { ToolInvoker } from '@/core/agent/ports/toolInvoker';
import { getCurrentAgentRunContext } from '../agentRunContext';

export function getToolInvoker(): ToolInvoker {
  return getCurrentAgentRunContext().toolInvoker;
}

export function setToolInvoker(_invoker: ToolInvoker): void {
  throw new Error(
    '[sidecar] setToolInvoker() called inside the sidecar bundle — toolInvoker is injected per-run via agentRunContext.run(), never slot-swapped. This indicates a wiring bug.',
  );
}
