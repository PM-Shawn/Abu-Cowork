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
 * uses `getSettingsMirrorReader()` directly, the SAME shared mirror
 * `agentLoopHost.ts` wires into the top-level `AgentLoopOptions.settingsReader`
 * for the parent run itself.
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
 * ── Abort-signal linkage — ALREADY DONE by the caller, not by this shim ──
 * Finding (verified by reading, corrects an assumption in this card's
 * brief): the SHELL-side `subagentRunner.ts`'s own `runSubagent(options)`
 * does NOT wire the parent↔child abort cascade itself — it just uses
 * whatever `options.signal` the CALLER already passed in. The cascade is
 * built by the CALLER via `createSubagentController(agentName, parentSignal)`
 * (`src/core/agent/subagentAbort.ts`) BEFORE `runSubagent` is ever invoked
 * — see `agentLoop.ts:755-758`: `const { signal: subagentSignal, cleanup } =
 * createSubagentController(delegateAgent.name, abortController.signal);`
 * then `runSubagent({ ..., signal: subagentSignal })`. `subagentAbort.ts` is
 * a zero-import, pure module-level singleton (`P1-3b-pre-REPORT.md`'s own
 * classification: "if the loop moves to sidecar this state should just live
 * wherever runAgentLoop runs (no shim needed, it migrates naturally with
 * the loop)") — `agentLoop.ts` already imports it directly, unshimmed, and
 * it already runs for real inside the sidecar bundle. So by the time
 * `runSubagent(options)` (this shim) is called, `options.signal` is ALREADY
 * the correctly-cascaded child signal — no additional wiring is needed or
 * built here; this shim just forwards `options.signal` unchanged, matching
 * the real shell-side `runSubagent`'s own behavior exactly.
 */
import { runSubagentLoop, type SubagentLoopOptions, type SubagentResult } from '@/core/agent/subagentLoop';
import { getCurrentAgentRunContext } from '../agentRunContext';
import { getSettingsMirrorReader } from '../settingsMirror';

export async function runSubagent(options: SubagentLoopOptions): Promise<SubagentResult> {
  const ctx = getCurrentAgentRunContext();

  const fullOptions: SubagentLoopOptions = {
    ...options,
    settingsReader: getSettingsMirrorReader(),
    toolInvoker: ctx.toolInvoker,
    capsPort: ctx.capsPort,
    workspaceReader: ctx.workspaceReader,
  };

  return runSubagentLoop(fullOptions);
}
