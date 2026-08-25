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
 * ── Ports: shared with the parent run, progress identity stays separate ──
 * `toolInvoker`/`capsPort`/`workspaceReader` come straight from
 * `getCurrentAgentRunContext()` — the SAME per-run reverse `ToolInvoker`
 * (→ `tool.invoke`), snapshot+notify `CapsPort`, and mirror-backed
 * `WorkspaceReader` the parent main-loop run already uses. A nested subagent
 * is dependent work done ON BEHALF of the parent run, so it shares the
 * parent's execution channel. Its progress ids still need an independent
 * app-owned namespace: separate nested model runs may both emit `call_1`, and
 * those ids join the same parent event stream.
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
 * ── `onProgress` — local delivery with an independent namespace ─────────
 * Verified against `agentLoop.ts:728-745`'s `onProgress` construction: it
 * calls `eventRouter.addChildStepToDelegate`/`.completeChildStep` — methods
 * on the SAME sidecar-local `EventRouter` `agentLoop.ts` itself built (via
 * `createEventRouter` over this run's frame-pushing ports), which already
 * pushes exec frames to the shell through the run's own coalescer. Since
 * `runSubagentLoop` calls `onProgress` synchronously in-process (no wire
 * crossing for a NESTED subagent, unlike `subagentHost.ts`'s TOP-LEVEL
 * `subagent.run` RPC, which does need to forward it via `subagent.progress`
 * because that runs in a SEPARATE dispatch from a possibly-different process
 * boundary). Delivery remains local and synchronous, but the shared
 * production helper namespaces every nested loop independently before its
 * events enter the parent router.
 *
 * ── Abort-signal linkage and scoped-run lifetime ─────────────────────────
 * The caller still creates the ordinary parent-linked subagent signal via
 * `createSubagentController`. For an unattended authorization scope, however,
 * shell `subagentRunner.ts` adds one more run-owned controller: background
 * commands may deliberately survive a successful tool result, so cleanup of
 * the ordinary subagent registry alone is not a lifetime boundary. This shim
 * mirrors the shell behavior exactly — scoped runs cascade parent aborts and
 * actively abort their private signal after every success/error terminal.
 * Unscoped runs keep forwarding the caller's signal unchanged.
 */
import { runSubagentLoop, type SubagentLoopOptions, type SubagentResult } from '@/core/agent/subagentLoop';
import { scopeSubagentLoopProgress } from '@/core/agent/subagentProgressIdentity';
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
    return runSubagentLoop(scopeSubagentLoopProgress(fullOptions));
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
    return await runSubagentLoop(scopeSubagentLoopProgress({
      ...fullOptions,
      signal: scopedController.signal,
    }));
  } finally {
    parentSignal?.removeEventListener('abort', abortFromParent);
    if (!scopedController.signal.aborted) {
      scopedController.abort(new Error('Scoped subagent run finished'));
    }
  }
}
