/**
 * Sidecar-local replacement for `src/core/agent/ports/authorizedPathsReader.ts`.
 *
 * Real forwarding shim (same class as `conversationStorageRun.ts`'s
 * `isMessageWrittenToDisk`, NOT a throwing bundle-graph-only stub): the
 * shell's `authorizedWorkspaces` map (`src/core/tools/pathSafety.ts`) is
 * populated by `authorizeWorkspace()` calls that only happen shell-side
 * (`registry.ts:407`, `triggerPermission.ts`) — the sidecar process has no
 * such state of its own, so `run_command`'s sandboxed writes need a live
 * reverse RPC to see the SAME authorized-paths set the shell would use, not
 * an always-empty local stand-in (which would under-authorize the OS-level
 * sandbox for every sidecar-run `run_command` call).
 *
 * Sends the `workspace.authorizedWritablePaths` REQUEST (shell handler:
 * `agentLoopRunner.ts`'s `handleWorkspaceAuthorizedPaths`, which returns the
 * REAL `getAuthorizedWritablePaths()` — same function
 * `createInProcessAuthorizedPathsReader` wraps in the shell/in-process case)
 * and returns its `string[]` result. No params needed — the authorized-paths
 * map is shell-global, not per-run.
 */
import type { AuthorizedPathsReader } from '@/core/agent/ports/authorizedPathsReader';
import { sendRequest } from '../rpcClient';

function createSidecarAuthorizedPathsReader(): AuthorizedPathsReader {
  return {
    getAuthorizedWritablePaths: async () => {
      const result = await sendRequest('workspace.authorizedWritablePaths', {});
      // Fail CLOSED on a malformed (resolved but non-array) result, same as a
      // rejected RPC: coercing to [] would silently under-authorize the OS
      // sandbox — exactly the outcome localTools/index.ts's fail-closed doc
      // block rules out. commandTools' outer try/catch turns this throw into
      // an error string BEFORE any command spawns.
      if (!Array.isArray(result)) {
        throw new Error(
          `[sidecar] workspace.authorizedWritablePaths returned a non-array result (${typeof result}) — refusing to run with an under-authorized sandbox`,
        );
      }
      return result as string[];
    },
  };
}

const current: AuthorizedPathsReader = createSidecarAuthorizedPathsReader();

export function getAuthorizedPathsReader(): AuthorizedPathsReader {
  return current;
}

export function setAuthorizedPathsReader(_reader: AuthorizedPathsReader): void {
  throw new Error(
    '[sidecar] setAuthorizedPathsReader() called inside the sidecar bundle — the reverse-RPC reader is the only implementation here, never slot-swapped. This indicates a wiring bug.',
  );
}
