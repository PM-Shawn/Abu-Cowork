/**
 * Sidecar-local replacement for `src/utils/aiEditSnapshots.ts` (P1-3d-4).
 *
 * THROWING bundle-graph-only shim, same discipline as `defaultWorkspaceRun.ts`
 * (see that file's doc for the full "why a whole shared file needs a shim
 * for code only its OTHER exports use" reasoning — identical situation
 * here): the real module imports `useChatStore` directly (forbidden by
 * `bundleGraphGuardPlugin`) and is dragged into the sidecar bundle only
 * because `fileTools.ts`'s `writeFileTool`/`editFileTool` statically import
 * its `snapshotBeforeAiEdit`. Neither `write_file` nor `edit_file` is
 * registered in `localTools/index.ts` (P1-3d-4 migrates only the READ-path
 * four), so this is never actually called inside the sidecar — write/edit
 * still run exclusively via the reverse `tool.invoke` path, in the SHELL,
 * where the real snapshot-into-version-history behavior is unaffected.
 *
 * The real function's contract is "NEVER throws" (fail-open — a snapshot
 * failure must never block the edit itself, per its own module doc). This
 * shim deliberately THROWS instead, same as `defaultWorkspaceRun.ts` — the
 * two contracts aren't in tension: "never throws" describes behavior for
 * legitimate calls from `write_file`/`edit_file` in the shell (unaffected,
 * since they never reach this file), whereas THIS file being reached at all
 * would mean write_file/edit_file started executing locally without this
 * batch's read-only migration being extended to cover them — a wiring bug
 * that should fail loudly, not silently no-op and lose version history.
 */
export async function snapshotBeforeAiEdit(
  _path: string,
  _opts: { loopId?: string; conversationId?: string; knownContent?: string },
): Promise<void> {
  throw new Error(
    '[sidecar] aiEditSnapshots.ts\'s snapshotBeforeAiEdit() reached inside the sidecar bundle — write_file/edit_file are not locally-executed tools (see localTools/index.ts), so this should never be called here. This indicates a wiring bug.',
  );
}
