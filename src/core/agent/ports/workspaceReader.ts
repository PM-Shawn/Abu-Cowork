import { useWorkspaceStore } from '@/stores/workspaceStore';

/**
 * Port abstracting agentLoop's reads of workspaceStore's `currentPath` — the
 * single global (not per-conversation) scalar used as a last-resort fallback
 * when a conversation has no workspace of its own. All three call sites in
 * agentLoop.ts follow the same shape: `convRecord?.workspacePath ?? this`.
 *
 * Same call-time-not-cached discipline as `SettingsReader`/`ConversationReader`
 * (see those files in this directory): the method re-fetches
 * `useWorkspaceStore.getState()` at call time, never memoized — so a
 * workspace bound mid-loop is observed by the very next call, not stale
 * from an earlier snapshot.
 */
export interface WorkspaceReader {
  /** Mirrors workspaceStore's `currentPath`. */
  getCurrentPath(): string | null;
}

/** Default in-process implementation over the Zustand store's synchronous
 *  getState(). This is the seam a future out-of-process agent runtime
 *  (headless Node sidecar) would replace with an IPC/RPC-backed
 *  implementation. */
export function createInProcessWorkspaceReader(): WorkspaceReader {
  return {
    getCurrentPath: () => useWorkspaceStore.getState().currentPath,
  };
}

let current: WorkspaceReader = createInProcessWorkspaceReader();

/** Module-level accessor for the app-wide default WorkspaceReader. All core/
 *  callers that don't receive an explicit reader via options should go
 *  through this instead of constructing their own in-process reader, so
 *  there's a single seam to flip when the headless Node runtime starts up
 *  (see `setWorkspaceReader`). */
export function getWorkspaceReader(): WorkspaceReader {
  return current;
}

/** One-time swap hook for a future out-of-process (IPC/RPC-backed) reader,
 *  to be called once at Node runtime startup. Not used anywhere yet — the
 *  in-process default remains active until a real out-of-process
 *  implementation exists. */
export function setWorkspaceReader(reader: WorkspaceReader): void {
  current = reader;
}
