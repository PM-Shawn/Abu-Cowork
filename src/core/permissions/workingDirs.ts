/**
 * Working-directory boundary — the single set of directories the agent may
 * operate in freely. Unifies the workspace, user-authorized directories, and a
 * small always-inside whitelist so both file and command gates share one notion
 * of "inside vs outside".
 */

import {
  getAuthorizedDirs,
  getAuthorizedWritablePaths,
  type AuthorizationScopeId,
} from '../tools/pathSafety';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { isWindows } from '../../utils/platform';

// Temp dirs are always considered inside (scratch space, never sensitive).
const ALWAYS_INSIDE = ['/tmp', '/private/tmp', '/var/tmp'];

function norm(raw: string): string {
  let p = raw.replace(/\\/g, '/').replace(/\/+/g, '/');
  const driveMatch = /^([A-Za-z]:)(?:\/|$)/.exec(p);
  const drive = driveMatch?.[1] ?? '';
  if (drive) p = p.slice(drive.length);
  const absolute = p.startsWith('/');
  const parts: string[] = [];

  for (const segment of p.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0) {
        parts.pop();
      } else if (!absolute && !drive) {
        parts.push(segment);
      }
      continue;
    }
    parts.push(segment);
  }

  let normalized: string;
  if (drive) {
    normalized = `${drive}${absolute ? '/' : ''}${parts.join('/')}`;
  } else {
    normalized = `${absolute ? '/' : ''}${parts.join('/')}`;
  }
  if (!normalized) normalized = drive ? `${drive}${absolute ? '/' : ''}` : absolute ? '/' : '.';
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return isWindows() ? normalized.toLowerCase() : normalized;
}

/** All directories the agent may operate in without escalation. */
export function allWorkingDirectories(scopeId?: AuthorizationScopeId): string[] {
  const ws = useWorkspaceStore.getState().currentPath;
  const dirs = [
    ...(scopeId === undefined && ws ? [ws] : []),
    ...getAuthorizedDirs(scopeId),
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

/**
 * Directories a scoped command may use as an implicit write location.
 *
 * Unscoped interactive command approval keeps the historical "working dirs"
 * behavior. Scoped unattended runs are stricter: read-only grants let commands
 * inspect a tree, but never make that tree a writable cwd or write target.
 */
export function commandWritableDirectories(scopeId?: AuthorizationScopeId): string[] {
  if (scopeId === undefined) return allWorkingDirectories();
  return [
    ...getAuthorizedWritablePaths(scopeId),
    ...ALWAYS_INSIDE,
  ].map(norm);
}
