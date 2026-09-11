/**
 * Sidecar-local replacement for `src/core/agent/defaultWorkspace.ts`
 * (P1-3d-4 introduced this as a THROWING stub; P1-3d A-write resolves it
 * into a real forwarding shim now that `write_file` is locally executed).
 *
 * ── Why this exists (bundle-graph reason, unchanged from P1-3d-4) ────────
 * The real module imports `useChatStore` / `useWorkspaceStore` /
 * `usePermissionStore` directly (all forbidden by `bundleGraphGuardPlugin`)
 * and is dragged into the sidecar bundle only because `fileTools.ts`'s
 * `writeFileTool.execute()` statically imports its `bindWorkspaceFromWrite`
 * — the only export any sidecar-reachable caller uses (`orchestrator.ts`
 * also imports `prepareSuggestedWorkspace` from here, but `orchestrator.ts`
 * is itself already redirected to a throwing stub, `orchestratorRun.ts`, so
 * that edge never actually loads the real file either — unchanged from
 * P1-3d-4's note).
 *
 * ── Why it's no longer a throwing stub ────────────────────────────────────
 * P1-3d A-write registers `write_file` in `localTools/index.ts` (readOnly:
 * false) — so `writeFileTool.execute()`, and therefore
 * `bindWorkspaceFromWrite`, IS now reachable inside the sidecar process for
 * a locally-executed write. The real function's own call site
 * (`fileTools.ts:264`, `void bindWorkspaceFromWrite(...)`) is deliberately
 * fire-and-forget — its result is never awaited or its rejection observed,
 * "must never affect the write result" per that call site's own comment.
 * This shim preserves that exact contract: it forwards as a NOTIFICATION
 * (`workspace.bindFromWrite`), never a request — there is no response to
 * wait for, and the shim itself can't fail in a way the caller would ever
 * see (send-and-forget, matching `sendNotification`'s own fire-and-forget
 * transport — no try/catch needed here, `writeLine` under the hood is a
 * synchronous stdout write).
 *
 * The shell-side handler (`agentLoopRunner.ts`'s `handleWorkspaceBindFromWrite`)
 * calls the REAL `bindWorkspaceFromWrite` — with the REAL `useChatStore`/
 * `useWorkspaceStore`/`usePermissionStore` writes — so a locally-executed
 * write under `~/Abu/` still binds/authorizes the default workspace exactly
 * as it would via the reverse `tool.invoke` path (where `write_file` runs
 * shell-side and reaches the real function directly).
 */
import { sendNotification } from '../rpcClient';
import { getCurrentAgentRunContext } from '../agentRunContext';

export async function bindWorkspaceFromWrite(
  conversationId: string | undefined,
  path: string,
  _interactionMode: 'foreground' | 'background',
): Promise<void> {
  const { runId } = getCurrentAgentRunContext();
  // Do not forward the caller-supplied mode: the shell handler derives it from
  // the run-owned session and passes that trusted value to the real binder.
  sendNotification('workspace.bindFromWrite', { runId, conversationId, path });
}
