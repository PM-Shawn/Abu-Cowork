/**
 * Sidecar-local replacement for `src/core/agent/ports/workspaceReader.ts`.
 *
 * Same bundle-graph reasoning as the other port shims in this directory —
 * the REAL module's default factory imports `useWorkspaceStore` from
 * `src/stores/workspaceStore.ts`. `subagentHost.ts` always injects a
 * per-run `workspaceReader` (backed by the shell-pushed
 * `workspacePathSnapshot` — see `subagentRunner.ts`'s wire params), so this
 * default is provably unreached; throws if it ever is.
 */
import type { WorkspaceReader } from '@/core/agent/ports/workspaceReader';

function throwingDefault(): WorkspaceReader {
  return {
    getCurrentPath: () => {
      throw new Error(
        '[sidecar] getWorkspaceReader() fallback reached inside the sidecar bundle — subagentHost.ts should always inject an explicit workspaceReader. This indicates a wiring bug.',
      );
    },
  };
}

let current: WorkspaceReader = throwingDefault();

export function getWorkspaceReader(): WorkspaceReader {
  return current;
}

export function setWorkspaceReader(reader: WorkspaceReader): void {
  current = reader;
}
