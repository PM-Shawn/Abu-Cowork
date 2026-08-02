import { useWorkspaceStore } from '@/stores/workspaceStore';
import { createPortSlot } from './portSlot';

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

/** Module-level slot for the app-wide default WorkspaceReader — see
 *  `portSlot.ts` for the shared get/set/swap-hook contract every port in
 *  this directory follows. All core/ callers that don't receive an
 *  explicit reader via options should go through `getWorkspaceReader()`
 *  instead of constructing their own in-process reader, so there's a
 *  single seam to flip when the headless Node runtime starts up (see
 *  `setWorkspaceReader`). */
const slot = createPortSlot<WorkspaceReader>(createInProcessWorkspaceReader);

export function getWorkspaceReader(): WorkspaceReader {
  return slot.get();
}

export function setWorkspaceReader(reader: WorkspaceReader): void {
  slot.set(reader);
}
