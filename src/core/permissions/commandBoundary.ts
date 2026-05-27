/**
 * Best-effort command boundary detection.
 *
 * Extracts the *write targets* of a shell command (output redirects, cp/mv
 * destinations, tee targets) and decides whether the command writes outside the
 * working directories. Used only to drive the confirm/review decision — it is
 * deliberately conservative (only flags 'outside' when confident) so benign
 * in-workspace commands are never over-prompted. The real enforcement floor for
 * commands is the OS sandbox, not this parser.
 */

import { allWorkingDirectories, isInsideWorkingDirs } from './workingDirs';

export type CmdBoundary = 'inside' | 'outside' | 'unknown';

/** Strip one layer of matching surrounding quotes. */
function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/** Resolve a raw path token to an absolute, normalized path. Returns null if it can't be resolved. */
function resolvePath(raw: string, cwd: string | undefined, home: string): string | null {
  let p = unquote(raw.trim());
  if (!p) return null;

  if (p === '~' || p.startsWith('~/')) {
    p = home + p.slice(1);
  } else if (p.startsWith('/')) {
    // absolute — keep
  } else {
    // relative — needs cwd to resolve
    if (!cwd) return null;
    p = cwd + '/' + p;
  }

  // Normalize separators and resolve . / .. segments
  p = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  const parts = p.split('/');
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return '/' + out.join('/');
}

/** Commands whose destination/path arguments represent a write/delete. */
const WRITE_DEST_COMMANDS = new Set(['cp', 'mv', 'tee', 'install']);

/**
 * Extract write-target path tokens from a command.
 * Focused on the vectors where "safe content escapes the workspace":
 * output redirections, and cp/mv/tee destinations.
 */
function extractWriteTargets(command: string): string[] {
  const targets: string[] = [];

  // Output redirections: > file, >> file. The optional fd is consumed by \d?
  // before '>', and '&' is excluded from the target, so '2>&1' captures nothing.
  const redirectRe = /(?:^|\s)\d?>>?\s*("[^"]+"|'[^']+'|[^\s|&;<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = redirectRe.exec(command)) !== null) {
    const tok = m[1];
    if (tok) targets.push(tok);
  }

  // cp/mv/tee destinations — operate on the first simple segment only
  // (compound commands with && / | are left as best-effort).
  const segment = command.split(/&&|\|\||\||;/)[0].trim();
  const tokens = segment.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  const cmd = tokens[0];
  if (cmd && WRITE_DEST_COMMANDS.has(cmd)) {
    const args = tokens.slice(1).filter((t) => !t.startsWith('-'));
    if (cmd === 'tee') {
      targets.push(...args); // tee writes to all file args
    } else if (args.length >= 2) {
      const dest = args[args.length - 1]; // cp/mv/install: last arg is destination
      if (dest) targets.push(dest);
    }
  }

  return targets;
}

/**
 * Decide whether a command writes outside the working directories.
 * Conservative: returns 'unknown' unless write targets are confidently resolved.
 */
export function analyzeCommandBoundary(command: string, cwd: string | undefined, home: string): CmdBoundary {
  const targets = extractWriteTargets(command);
  if (targets.length === 0) return 'unknown';

  const dirs = allWorkingDirectories();
  let sawInside = false;
  for (const raw of targets) {
    const abs = resolvePath(raw, cwd, home);
    if (!abs) return 'unknown'; // can't resolve → bail conservatively
    if (isInsideWorkingDirs(abs, dirs)) {
      sawInside = true;
    } else {
      return 'outside'; // any write target outside the working set → escalate
    }
  }
  return sawInside ? 'inside' : 'unknown';
}
