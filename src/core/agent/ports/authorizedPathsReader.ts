import { getAuthorizedWritablePaths } from '../../tools/pathSafety';
import { createPortSlot } from './portSlot';

/**
 * Port abstracting `commandTools.ts`'s (`run_command`) read of
 * `pathSafety.ts`'s module-level `authorizedWorkspaces` map — the set of
 * paths the user has explicitly authorized for write access, forwarded to
 * the OS-level sandbox (Seatbelt) so a sandboxed child process (cp, python,
 * ...) can still write to them.
 *
 * ASYNC (unlike `WorkspaceReader`'s sync `getCurrentPath()`): the shell-side
 * `authorizedWorkspaces` map is populated by `authorizeWorkspace()`
 * (`registry.ts`, `triggerPermission.ts`) and lives ONLY in the shell
 * process. A future out-of-process (headless Node sidecar) implementation of
 * this port needs a reverse RPC round trip to read it — see
 * `sidecar/src/shims/authorizedPathsReaderRun.ts` for that implementation —
 * so the interface is async from day one rather than sync-in-shell/
 * async-in-sidecar (which would force call sites to change shape later).
 */
export interface AuthorizedPathsReader {
  /** Mirrors `pathSafety.ts`'s `getAuthorizedWritablePaths()`. */
  getAuthorizedWritablePaths(scopeId?: string): Promise<string[]>;
}

/** Default in-process implementation wrapping the real (synchronous)
 *  `pathSafety.ts` function in a resolved Promise. This is the seam a future
 *  out-of-process agent runtime (headless Node sidecar) would replace with
 *  an IPC/RPC-backed implementation. */
export function createInProcessAuthorizedPathsReader(): AuthorizedPathsReader {
  return {
    getAuthorizedWritablePaths: async (scopeId?: string) => getAuthorizedWritablePaths(scopeId),
  };
}

/** Module-level slot for the app-wide default AuthorizedPathsReader — see
 *  `portSlot.ts` for the shared get/set/swap-hook contract every port in
 *  this directory follows. All core/ callers that don't receive an explicit
 *  reader via options should go through `getAuthorizedPathsReader()` instead
 *  of constructing their own in-process reader, so there's a single seam to
 *  flip when the headless Node runtime starts up (see
 *  `setAuthorizedPathsReader`). */
const slot = createPortSlot<AuthorizedPathsReader>(createInProcessAuthorizedPathsReader);

export function getAuthorizedPathsReader(): AuthorizedPathsReader {
  return slot.get();
}

export function setAuthorizedPathsReader(reader: AuthorizedPathsReader): void {
  slot.set(reader);
}
