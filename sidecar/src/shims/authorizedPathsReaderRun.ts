/**
 * Sidecar-local replacement for `src/core/agent/ports/authorizedPathsReader.ts`.
 *
 * Real forwarding shim (same class as `conversationStorageRun.ts`'s
 * `replaceMessageById`, NOT a throwing bundle-graph-only stub): the
 * shell-side path authorization maps (`src/core/tools/pathSafety.ts`) are
 * populated by `authorizeWorkspace()` / `scopedAuthorizeWorkspace()` calls
 * that only happen in the shell — the sidecar process has no such state of
 * its own, so `run_command`'s sandboxed writes need a live reverse RPC to
 * see the SAME run/session-scoped authorized-path set the shell would use,
 * not an always-empty local stand-in (which would under-authorize the
 * OS-level sandbox for every sidecar-run `run_command` call).
 *
 * Sends the `workspace.authorizedWritablePaths` REQUEST (shell handler:
 * `agentLoopRunner.ts`'s `handleWorkspaceAuthorizedPaths`, which returns the
 * REAL `getAuthorizedWritablePaths(session.options.authorizationScopeId)` —
 * same function `createInProcessAuthorizedPathsReader` wraps in the
 * shell/in-process case) and returns its `string[]` result. The sidecar sends
 * the current runId from AgentRunContext; outside a registered run it fails
 * closed rather than asking for global writable paths.
 */
import type { AuthorizedPathsReader } from '@/core/agent/ports/authorizedPathsReader';
import { getCurrentAgentRunContext } from '../agentRunContext';
import { sendRequest } from '../rpcClient';

function createSidecarAuthorizedPathsReader(): AuthorizedPathsReader {
  return {
    getAuthorizedWritablePaths: async () => {
      const { runId } = getCurrentAgentRunContext();
      const result = await sendRequest('workspace.authorizedWritablePaths', { runId });
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
