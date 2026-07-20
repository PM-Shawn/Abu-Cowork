/**
 * Sidecar-local replacement for `src/core/agent/defaultWorkspace.ts`
 * (P1-3d-4).
 *
 * THROWING bundle-graph-only shim, same discipline as `orchestratorRun.ts` /
 * `entryOrchestrationRun.ts`: the real module imports `useChatStore` /
 * `useWorkspaceStore` / `usePermissionStore` directly (all forbidden by
 * `bundleGraphGuardPlugin`) and is dragged into the sidecar bundle ONLY
 * because `fileTools.ts`'s `writeFileTool.execute()` statically imports its
 * `bindWorkspaceFromWrite` — the ONLY export any sidecar-reachable caller
 * uses (verified by grep: `orchestrator.ts` also imports
 * `prepareSuggestedWorkspace` from here, but `orchestrator.ts` is ITSELF
 * already redirected to a throwing stub, `orchestratorRun.ts`, so that edge
 * never actually loads the real file either).
 *
 * `write_file` is NOT registered in `localTools/index.ts` (P1-3d-4 migrates
 * only the READ-path four: read_file/list_directory/search_files/find_files
 * — see that file's module doc) — so `writeFileTool.execute()`, and
 * therefore `bindWorkspaceFromWrite`, is NEVER actually called inside the
 * sidecar process; `write_file` still runs exclusively via the reverse
 * `tool.invoke` path, in the SHELL, where the real `defaultWorkspace.ts`
 * (and its store writes) runs completely unchanged. This shim exists purely
 * so `fileTools.ts` — one file exporting BOTH the read tools we migrate AND
 * the write/edit/delete tools we don't — is bundle-safe as a WHOLE MODULE
 * (ES module semantics: importing any one named export evaluates every
 * top-level import in the file, including ones only used by unmigrated
 * exports). Throws loudly if ever actually reached, so a future change that
 * DOES start calling `write_file` locally fails fast instead of silently
 * writing without the default-workspace binding.
 */
export async function bindWorkspaceFromWrite(_conversationId: string | undefined, _path: string): Promise<void> {
  throw new Error(
    '[sidecar] defaultWorkspace.ts\'s bindWorkspaceFromWrite() reached inside the sidecar bundle — write_file is not a locally-executed tool (see localTools/index.ts), so this should never be called here. This indicates a wiring bug, not a legitimate "no default workspace" case.',
  );
}
