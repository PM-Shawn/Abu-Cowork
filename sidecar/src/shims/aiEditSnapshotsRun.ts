/**
 * Sidecar-local replacement for `src/utils/aiEditSnapshots.ts` (P1-3d-4
 * introduced this as a THROWING stub; P1-3d A-write resolves it into a real
 * forwarding shim now that `write_file`/`edit_file` are locally executed).
 *
 * ── Why this exists (bundle-graph reason, unchanged from P1-3d-4) ────────
 * The real module imports `useChatStore` directly (forbidden by
 * `bundleGraphGuardPlugin`) and is dragged into the sidecar bundle only
 * because `fileTools.ts`'s `writeFileTool`/`editFileTool` statically import
 * its `snapshotBeforeAiEdit`.
 *
 * ── Why it's no longer a throwing stub ────────────────────────────────────
 * P1-3d A-write registers both `write_file` and `edit_file` in
 * `localTools/index.ts` (readOnly: false) — so `snapshotBeforeAiEdit` IS now
 * reachable inside the sidecar process. UNLIKE `bindWorkspaceFromWrite`,
 * both call sites (`fileTools.ts:257`, `write_file`; `fileTools.ts:340`,
 * `edit_file`) `await` this call BEFORE writing to disk — the "before"
 * snapshot must be captured before the real write lands — so this shim
 * forwards as a REQUEST (`snapshot.beforeAiEdit`), not a notification: the
 * caller needs the round trip to complete (successfully or not) before it
 * proceeds to `writeTextFile`.
 *
 * The real function's contract is "NEVER throws" (fail-open — a snapshot
 * failure must never block the edit itself, per its own module doc: any
 * internal failure is caught, unmarked for retry, and logged via
 * `console.warn`). This shim preserves that SAME contract at the RPC
 * boundary: a transport failure (rejected/thrown `sendRequest`, e.g. the
 * shell process died mid-request) degrades to "no snapshot captured this
 * turn" — logged, never re-thrown — so a sidecar-side snapshot failure can
 * never block a locally-executed write/edit either, exactly mirroring the
 * real function's own fail-open discipline for a legitimate shell-side call.
 *
 * The shell-side handler (`agentLoopRunner.ts`'s `handleSnapshotBeforeAiEdit`)
 * calls the REAL `snapshotBeforeAiEdit` — with the REAL `useChatStore`
 * label lookup and the REAL `canvasVersions.ts` version-history write — so a
 * locally-executed write/edit still leaves the same revertable "before"
 * state the reverse `tool.invoke` path would produce.
 *
 * ── Latency note ───────────────────────────────────────────────────────────
 * This is the ONE extra round trip P1-3d A-write's local-write path still
 * pays (vs. the zero-round-trip Tier A tools) — every locally-executed
 * `write_file`/`edit_file` call now waits on ONE sidecar→shell→sidecar hop
 * before the disk write, instead of the TWO-TO-THREE hops the reverse
 * `tool.invoke` path pays for the ENTIRE tool call (sidecar→shell dispatch,
 * plus the shell's own fs work). Still a net latency win end-to-end, just
 * not a full elimination — see the report's evaluation.
 */
import { sendRequest } from '../rpcClient';
import { getCurrentAgentRunContext } from '../agentRunContext';

export async function snapshotBeforeAiEdit(
  path: string,
  opts: { loopId?: string; conversationId?: string; knownContent?: string },
): Promise<void> {
  const { runId } = getCurrentAgentRunContext();
  try {
    await sendRequest('snapshot.beforeAiEdit', { runId, path, opts });
  } catch (err) {
    // Fail-open, matches the real function's own never-throws contract (see
    // module doc) — a transport failure here degrades to "no snapshot this
    // turn", never a blocked write. console.warn is safe here: main.ts
    // redirects console.log/info/debug to console.error (stdout is the
    // JSON-RPC channel), but console.warn already writes to stderr by
    // Node's own default, same as console.error — no redirect needed.
    console.warn('[sidecar] snapshot.beforeAiEdit request failed (non-blocking)', path, err);
  }
}
