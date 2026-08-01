/**
 * Sidecar-local replacement for `src/core/agent/lifecycleHooks.ts`.
 *
 * The real module's import graph is itself bundle-safe (zero imports — see
 * P1-3a-pre-REPORT.md §3's `lifecycleHooks` row) — the problem isn't
 * bundling, it's BEHAVIOR: its listeners are registered by webview-side UI
 * code (notification panel, todo panel, skill hooks, ...). A sidecar-
 * resident `emitHook()` calling the REAL module would only ever reach
 * listeners registered inside the (headless, UI-less) sidecar process —
 * i.e. none of them — silently dropping every hook event. This shim
 * instead forwards each event back to the shell over the reverse-RPC
 * channel, where the REAL `emitHook()` (with the REAL listeners) runs —
 * see `subagentRunner.ts`'s `handleHookEmit`/`handleHookNotify`.
 *
 * Request vs notification split — see subagentRunner.ts's "Hooks verdict"
 * doc comment for the full reasoning: only `preToolCall` has its return
 * value consumed (`subagentLoop.ts`'s block/modify AND — verified this
 * batch — `toolExecutor.ts`'s identical `preEvent.blocked`/
 * `preEvent.modifiedInput` consumption at its own `preToolCall` call site),
 * so it alone pays for a round-trip; everything else is fire-and-forget.
 * This split is GENERIC (branches on `event.type`, not a hardcoded
 * allowlist of specific types) — verified it already covers every hook
 * type the MAIN loop emits too: `grep -n "emitHook(" src/core/agent/
 * agentLoop.ts src/core/agent/toolExecutor.ts` plus reading each call
 * site's `type:` literal shows `agentStart`/`agentEnd`/`turnStart`/
 * `turnEnd` (agentLoop.ts) and `preToolCall`/`postToolCall`
 * (toolExecutor.ts) — none are `subagentStart`/`subagentEnd` (subagent-only,
 * unaffected), and all 6 fall correctly into the existing two-way split
 * with ZERO changes needed to that part of this file.
 *
 * ── P1-3B-3B rework: dual-context runId resolution ───────────────────────
 * The ONE genuine bug (fixed below): `runId` used to resolve ONLY via
 * `getCurrentSubagentRunContext()` — correct for the P1-3a subagent-only
 * world, but `agentLoop.ts`'s/`toolExecutor.ts`'s `emitHook()` calls run
 * inside `agentRunContext.run(...)` (P1-3B-3A), NOT `subagentRunContext`,
 * so the old resolution would throw "outside subagentHost.ts's
 * AsyncLocalStorage scope" for every main-loop hook. Same dual-fallback
 * pattern as `i18nRun.ts`/`enterpriseCredsRun.ts`/`permissionBridgeRun.ts`:
 * try `agentRunContext` first (covers the main loop AND any subagent
 * nested under one via `shims/subagentRunnerRun.ts`, which shares the
 * parent's `agentRunContext` scope), fall back to `subagentRunContext`
 * (top-level `subagent.run` RPC, unchanged from P1-3a), throw if neither.
 */
import { sendRequest, sendNotification } from '../rpcClient';
import { getCurrentAgentRunContext } from '../agentRunContext';
import { getCurrentSubagentRunContext } from '../subagentRunContext';
import type { HookEvent } from '@/core/agent/lifecycleHooks';

function resolveRunId(): string {
  try {
    return getCurrentAgentRunContext().runId;
  } catch {
    try {
      return getCurrentSubagentRunContext().runId;
    } catch {
      throw new Error(
        '[sidecar] emitHook() called outside both agentRunContext and subagentRunContext scopes — no run context available. This indicates a wiring bug.',
      );
    }
  }
}

export function emitHook<T extends HookEvent>(event: T): T | Promise<T> {
  const runId = resolveRunId();
  let wireEvent: HookEvent = event;
  if (event.type === 'preToolCall' || event.type === 'postToolCall') {
    const { abortSignal: _abortSignal, ...withoutSignal } = event;
    wireEvent = withoutSignal as unknown as HookEvent;
  }

  if (event.type === 'preToolCall') {
    return sendRequest('hook.emit', { runId, event: wireEvent }) as Promise<T>;
  }

  sendNotification('hook.notify', { runId, event: wireEvent });
  return event;
}
