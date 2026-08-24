/**
 * Sidecar-local replacement for `src/core/agent/subagentRunner.ts`'s
 * `runSubagent()` — the in-sidecar path for a subagent delegated FROM a
 * sidecar-run MAIN loop.
 *
 * Two real call sites reach this (both traced, not assumed): `agentLoop.ts:761`
 * (the `@abu`-mention delegate path, inside `runAgentLoop` itself — reachable
 * sidecar-side for real) and `src/core/tools/definitions/agentTools.ts:307`'s
 * `delegate_to_agent` tool / `orchestrationTools.ts:386`'s `run_agent_batch`
 * tool. The latter two are part of the `tools/builtins.ts` DRAGGER cluster
 * (redirected wholesale to `shims/builtinsRun.ts`, §6) and — since ALL tool
 * execution reverses to the shell via `tool.invoke` — their `execute()`
 * bodies (including their own `runSubagent({...})` calls) NEVER actually run
 * inside the sidecar bundle; only `agentLoop.ts`'s own direct import of
 * `runSubagent` from `./subagentRunner` is genuinely reachable here. Both
 * call sites were read anyway (per the card's instruction) to build a
 * `SubagentLoopOptions`-shaped implementation general enough for either.
 *
 * ── Ports: shared with the parent run, not a new reverse-RPC identity ────
 * `toolInvoker`/`capsPort`/`workspaceReader` come straight from
 * `getCurrentAgentRunContext()` — the SAME per-run reverse `ToolInvoker`
 * (→ `tool.invoke`), snapshot+notify `CapsPort`, and mirror-backed
 * `WorkspaceReader` the parent main-loop run already uses. A nested
 * subagent is NOT a new peer run with its own identity; it's dependent
 * work done ON BEHALF of the parent run, so it shares the parent's channel.
 * `settingsReader` is the one exception — `AgentRunContext` deliberately has
 * no `settingsReader` field (see `agentRunContext.ts`'s own doc: settings
 * live in the sidecar-GLOBAL `settingsMirror.ts`, not per-run) — so this
 * uses the caller's frozen `settingsReader` when present. The main loop
 * passes its entry provider/model snapshot so a nested agent cannot drift to
 * a later global selection. Only legacy callers fall back to the shared
 * mirror.
 *
 * ── `runSubagentLoop` called DIRECTLY, in-process — no reverse RPC ───────
 * We're already inside the sidecar process; there is no shell round trip to
 * make. `@/core/agent/subagentLoop`'s `runSubagentLoop` is REAL, bundled
 * code (not shimmed) — this shim just constructs its options correctly and
 * calls it, returning the real `SubagentResult` instance unchanged (no
 * serialize/deserialize needed, unlike `subagentHost.ts`'s top-level
 * `subagent.run` RPC handler, which crosses the shell↔sidecar wire).
 *
 * ── `onProgress` — plain passthrough, no forwarding needed ───────────────
 * Verified against `agentLoop.ts:728-745`'s `onProgress` construction: it
 * calls `eventRouter.addChildStepToDelegate`/`.completeChildStep` — methods
 * on the SAME sidecar-local `EventRouter` `agentLoop.ts` itself built (via
 * `createEventRouter` over this run's frame-pushing ports), which already
 * pushes exec frames to the shell through the run's own coalescer. Since
 * `runSubagentLoop` calls `onProgress` synchronously in-process (no wire
 * crossing for a NESTED subagent, unlike `subagentHost.ts`'s TOP-LEVEL
 * `subagent.run` RPC, which does need to forward it via `subagent.progress`
 * because that runs in a SEPARATE dispatch from a possibly-different
 * process boundary), no special handling is needed here — thread
 * `options.onProgress` straight through unchanged.
 *
 * ── Abort-signal linkage and scoped terminal cleanup ────────────────────
 * The caller already supplies the parent-linked child signal. Scoped runs
 * need one additional owner layer, matching the real shell-side
 * `subagentRunner.ts`: a background command can return while its native
 * process listener remains live, so the nested run gets its own controller
 * and that controller is aborted on every terminal path. Parent abort still
 * cascades into it; an unscoped interactive subagent keeps the original
 * signal unchanged.
 */
import { runSubagentLoop, type SubagentLoopOptions, type SubagentResult } from '@/core/agent/subagentLoop';
import { getCurrentAgentRunContext } from '../agentRunContext';
import { getSettingsMirrorReader } from '../settingsMirror';

export async function runSubagent(options: SubagentLoopOptions): Promise<SubagentResult> {
  const ctx = getCurrentAgentRunContext();

  const fullOptions: SubagentLoopOptions = {
    ...options,
    settingsReader: options.settingsReader ?? getSettingsMirrorReader(),
    toolInvoker: ctx.toolInvoker,
    capsPort: ctx.capsPort,
    workspaceReader: ctx.workspaceReader,
  };

  if (options.authorizationScopeId === undefined) {
    return runSubagentLoop(fullOptions);
  }

  const scopedController = new AbortController();
  const parentSignal = options.signal;
  const abortFromParent = () => scopedController.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  try {
    return await runSubagentLoop({ ...fullOptions, signal: scopedController.signal });
  } finally {
    parentSignal?.removeEventListener('abort', abortFromParent);
    if (!scopedController.signal.aborted) {
      scopedController.abort(new Error('Scoped subagent run finished'));
    }
  }
}
