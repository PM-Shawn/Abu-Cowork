/**
 * Working-directory boundary — the single set of directories the agent may
 * operate in freely. Unifies the workspace, user-authorized directories, and a
 * small always-inside whitelist so both file and command gates share one notion
 * of "inside vs outside".
 */

import { getAuthorizedDirs } from '../tools/pathSafety';
import { useWorkspaceStore } from '../../stores/workspaceStore';

// Temp dirs are always considered inside (scratch space, never sensitive).
const ALWAYS_INSIDE = ['/tmp', '/private/tmp', '/var/tmp'];

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
}

/** All directories the agent may operate in without escalation. */
export function allWorkingDirectories(): string[] {
  const ws = useWorkspaceStore.getState().currentPath;
  const dirs = [
    ...(ws ? [ws] : []),
    ...getAuthorizedDirs(),
    ...ALWAYS_INSIDE,
  ];
  return dirs.map(norm);
}

/**
 * Whether an absolute path is inside the working set.
 * @param dirs - optional pre-computed working dirs (avoids recomputing in loops)
 */
export function isInsideWorkingDirs(absPath: string, dirs: string[] = allWorkingDirectories()): boolean {
  const p = norm(absPath);
  return dirs.some((d) => p === d || p.startsWith(d + '/'));
}
