/**
 * Sidecar-local replacement for `src/core/agent/permissionBridge.ts`.
 *
 * Mixed shim — each export gets its own verdict, per the P1-3a decision
 * framework, verified against the ACTUAL consumed surface (not the whole
 * file): `grep -n "permissionBridge" src/core/agent/agentLoop.ts
 * src/core/agent/toolExecutor.ts src/core/agent/eventRouter.ts` shows only
 * `setLoopContext`/`clearLoopContext` (toolExecutor.ts) and
 * `drainConfirmationQueue`/`drainFilePermissionQueue`/`drainWorkspaceRequest`/
 * `drainUserQuestions`/`requestCommandConfirmation`/`requestFilePermission`
 * (agentLoop.ts) are ever imported from this module by sidecar-reachable
 * code — `getLoopContext`/`getCurrentLoopContext`/`requestWorkspace`/
 * `requestUserQuestion` are NOT imported by any of the three.
 *
 * ── `drain*` (4 functions) → REAL forwarding shim ──────────────────────
 * Forward as the `approval.drain` NOTIFICATION `{ runId, kind }`. `kind`
 * values verified against `src/core/agent/agentLoopRunner.ts`'s
 * `DRAIN_BY_KIND` record (NOT just the design doc's prose): `'command'` →
 * `drainConfirmationQueue`, `'file-permission'` → `drainFilePermissionQueue`,
 * `'workspace'` → `drainWorkspaceRequest`, `'user-question'` →
 * `drainUserQuestions` — exactly the 4 string literals that record expects.
 * `runId` resolved via the same dual-context (agentRunContext first,
 * subagentRunContext fallback) pattern as `i18nRun.ts`/`enterpriseCredsRun.ts`
 * — `drainConfirmationQueue` etc. are called from `agentLoop.ts` (main-loop
 * scope) but the same names are structurally callable from a subagent
 * context too if ever wired that way, so both are covered defensively; if
 * truly outside both scopes, that's a real bug and this throws (per
 * `agentLoopRunner.ts`'s own doc: the underlying permissionBridge queues are
 * GLOBAL, not per-run, so a wrong/missing runId is "informational only" on
 * the shell side, but resolving no runId at all still indicates a caller
 * invoked this from outside any run scope, which should never happen).
 *
 * ── `setLoopContext`/`clearLoopContext` → real no-op ────────────────────
 * `agentLoopRunner.ts`'s `installShellLoopContext`/`removeShellLoopContext`
 * (verified present — see that file) already builds and clears the REAL
 * shell-side `LoopContext` (with the REAL `EventRouter`, the REAL abort
 * signal, etc.) at `agent.run` dispatch/settle time, keyed by the same
 * `loopId` — this is the shell's OWN responsibility, not the sidecar's.
 * `toolExecutor.ts`'s `setLoopContext(loopId, {...})` call (built from
 * data that's ALREADY split across ports — `abortController.signal`,
 * `eventRouter`, `toolCallToStepId` — none of which travel back to the shell
 * as a reconstructable LoopContext object anyway) is therefore inert
 * sidecar-side: writing it to a sidecar-local Map would only ever be read by
 * `getLoopContext`/`getCurrentLoopContext`, which — see below — are never
 * called from sidecar-reachable code. So there is nothing for a sidecar-local
 * write to feed.
 *
 * ── `requestCommandConfirmation`/`requestFilePermission` → throw (verified
 * dead) ───────────────────────────────────────────────────────────────────
 * Evidence, not assumption: `grep -n
 * "requestCommandConfirmation\|requestFilePermission" src/core/agent/agentLoop.ts`
 * shows both are referenced ONLY as the right-hand side of a `??` default
 * (`options?.commandConfirmCallback ?? requestCommandConfirmation`), never
 * invoked with `()` directly. The resulting `confirmCb`/`filePermCb`
 * function VALUES are threaded into `toolInvoker.executeAnyTool(name, input,
 * confirmCb, filePermCb, context)` (toolExecutor.ts) and into
 * `runSubagent({ commandConfirmCallback: confirmCb, filePermissionCallback:
 * filePermCb, ... })` (agentLoop.ts's `@abu`-delegate path). Both of THOSE
 * receivers discard the callback sidecar-side: `agentLoopHost.ts`'s reverse
 * `createReverseToolInvoker.executeAnyTool` has an underscore-prefixed
 * `(_onConfirm, _onFilePerm, ...)` signature (never reads them — a real
 * `tool.invoke` reverses to the shell, where the SHELL's OWN session
 * callbacks are threaded in instead, per `subagentRunner.ts`'s
 * `handleToolInvoke`); and `shims/subagentRunnerRun.ts`'s nested subagent
 * path shares that SAME per-run `toolInvoker`, so the nested case discards
 * them too. So these two functions are provably NEVER actually CALLED
 * anywhere reachable from the sidecar bundle — throwing (rather than a
 * silent no-op returning `false`/`true`, which would be indistinguishable
 * from a real deny/allow decision) is the correct "escalate cleanly if this
 * assumption ever breaks" treatment.
 *
 * ── `getLoopContext`/`getCurrentLoopContext` → not exported ─────────────
 * `getLoopContext` is imported only by `src/core/tools/registry.ts` and
 * `src/core/tools/definitions/{agentTools,orchestrationTools}.ts` — all part
 * of the `tools/builtins.ts` DRAGGER cluster, which is redirected WHOLESALE
 * to `shims/builtinsRun.ts` and never reaches the real `registry.ts`/
 * `agentTools.ts` in the sidecar bundle at all (tool execution always
 * reverses via `tool.invoke`). `getCurrentLoopContext` has zero importers
 * outside `permissionBridge.ts` itself. Neither name is imported by
 * `agentLoop.ts`/`toolExecutor.ts`/`eventRouter.ts` — confirmed by the same
 * grep cited above. Omitted rather than speculatively stubbed.
 */
import type { ConfirmationInfo } from '@/core/tools/commandSafety';
import type { FilePermissionCallback } from '@/core/agent/ports/toolInvoker';
import type { LoopContext } from '@/core/agent/permissionBridge';
import { sendNotification } from '../rpcClient';
import { getCurrentAgentRunContext } from '../agentRunContext';
import { getCurrentSubagentRunContext } from '../subagentRunContext';

function resolveRunId(): string {
  try {
    return getCurrentAgentRunContext().runId;
  } catch {
    try {
      return getCurrentSubagentRunContext().runId;
    } catch {
      throw new Error(
        '[sidecar] permissionBridge drain function called outside both agentRunContext and subagentRunContext scopes — no run context available. This indicates a wiring bug.',
      );
    }
  }
}

function drain(kind: 'command' | 'file-permission' | 'workspace' | 'user-question'): void {
  sendNotification('approval.drain', { runId: resolveRunId(), kind });
}

export function drainConfirmationQueue(): void {
  drain('command');
}

export function drainFilePermissionQueue(): void {
  drain('file-permission');
}

export function drainWorkspaceRequest(): void {
  drain('workspace');
}

export function drainUserQuestions(): void {
  drain('user-question');
}

/** Real no-op — see module doc. `agentLoopRunner.ts`'s `installShellLoopContext`/`removeShellLoopContext` own the real shell-side LoopContext lifecycle. */
export function setLoopContext(_loopId: string, _ctx: LoopContext): void {
  // Intentional no-op.
}

/** Real no-op — see module doc. */
export function clearLoopContext(_loopId: string): void {
  // Intentional no-op.
}

export async function requestCommandConfirmation(_info: ConfirmationInfo, _loopId?: string): Promise<boolean> {
  throw new Error(
    '[sidecar] requestCommandConfirmation() invoked directly inside the sidecar bundle — this should never happen. agentLoop.ts only ever threads this function as a default callback VALUE into toolInvoker.executeAnyTool()/runSubagent(), both of which discard it sidecar-side (tool execution always reverses to the shell via tool.invoke, where the shell\'s own session callback is used instead). Reaching this indicates a wiring bug, not a legitimate confirmation request.',
  );
}

export const requestFilePermission: FilePermissionCallback = async (_request) => {
  throw new Error(
    '[sidecar] requestFilePermission() invoked directly inside the sidecar bundle — this should never happen (same reasoning as requestCommandConfirmation — see this file\'s module doc). Reaching this indicates a wiring bug.',
  );
};
