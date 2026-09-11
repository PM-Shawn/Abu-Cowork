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

import { allWorkingDirectories, commandWritableDirectories, isInsideWorkingDirs } from './workingDirs';
import type { AuthorizationScopeId } from '../tools/pathSafety';

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

  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(p);
  if (p === '~' || p.startsWith('~/')) {
    p = home + p.slice(1);
  } else if (p.startsWith('/') || isWindowsAbsolute) {
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
  if (out[0] && /^[A-Za-z]:$/.test(out[0])) {
    return out.join('/');
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

/** Split shell command segments without treating quoted control characters as operators. */
function splitUnquotedCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const pushCurrent = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = '';
  };

  for (let index = 0; index < command.length; index++) {
    const ch = command[index];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '|') {
      pushCurrent();
      if (command[index + 1] === ch) index++;
      continue;
    }
    if (ch === '&' && current.endsWith('>')) {
      current += ch; // fd redirection such as 2>&1
      continue;
    }
    if (ch === '&') {
      pushCurrent();
      if (command[index + 1] === '&') index++;
      continue;
    }
    current += ch;
  }
  pushCurrent();
  return segments;
}

function simpleTokens(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function optionValue(args: string[], names: string[]): string | undefined {
  const foldedNames = names.map((name) => name.toLowerCase());
  for (let index = 0; index < args.length; index++) {
    const folded = args[index].toLowerCase();
    const exactIndex = foldedNames.indexOf(folded);
    if (exactIndex >= 0) return args[index + 1];
    for (const name of foldedNames) {
      if (folded.startsWith(`${name}=`)) return args[index].slice(name.length + 1);
    }
  }
  return undefined;
}

function positionalArgs(args: string[]): string[] {
  let afterDoubleDash = false;
  return args.filter((arg) => {
    if (arg === '--') {
      afterDoubleDash = true;
      return false;
    }
    return afterDoubleDash || !arg.startsWith('-');
  });
}

/**
 * Extract direct write targets for the full/no-workspace hard-floor preflight.
 * This is intentionally separate from analyzeCommandBoundary: adding commands
 * here must not change standard/smart interactive confirmation behaviour.
 */
function extractFullNoWorkspaceWriteTargets(command: string): string[] {
  const targets = extractWriteTargets(command);

  for (const segment of splitUnquotedCommandSegments(command)) {
    const tokens = simpleTokens(segment);
    const rawCommand = unquote(tokens[0] ?? '').replace(/\\/g, '/');
    const commandName = rawCommand.split('/').pop()?.toLowerCase();
    if (!commandName) continue;
    const args = tokens.slice(1);
    const positional = positionalArgs(args);

    if (['touch', 'mkdir', 'md', 'rm', 'rmdir', 'unlink', 'del', 'erase'].includes(commandName)) {
      targets.push(...positional);
      continue;
    }
    if (['cp', 'mv', 'install', 'copy', 'move'].includes(commandName) && positional.length >= 2) {
      targets.push(positional[positional.length - 1]);
      continue;
    }
    if (commandName === 'tee') {
      targets.push(...positional);
      continue;
    }

    const pathOption = optionValue(args, ['-Path', '-LiteralPath', '-FilePath']);
    const destinationOption = optionValue(args, ['-Destination']);
    if (['new-item', 'set-content', 'add-content', 'clear-content', 'remove-item', 'out-file'].includes(commandName)) {
      const target = pathOption ?? positional[0];
      if (target) targets.push(target);
      continue;
    }
    if (['copy-item', 'move-item'].includes(commandName)) {
      const target = destinationOption ?? positional[1];
      if (target) targets.push(target);
    }
  }

  return targets;
}

function explicitAbuPathMentions(command: string, home: string): string[] {
  const normalizedCommand = command.replace(/\\/g, '/');
  const prefixes = [home, '~', '$HOME', '${HOME}', '%USERPROFILE%', '$env:USERPROFILE'];
  const results: string[] = [];

  for (const prefix of prefixes) {
    const needle = `${prefix}/.abu`;
    const foldedCommand = normalizedCommand.toLowerCase();
    const foldedNeedle = needle.toLowerCase();
    let start = foldedCommand.indexOf(foldedNeedle);
    while (start >= 0) {
      let end = start + needle.length;
      while (end < normalizedCommand.length && !/[\s"'`;&|<>()]/.test(normalizedCommand[end])) end++;
      const suffix = normalizedCommand.slice(start + prefix.length, end);
      results.push(`${home}${suffix}`);
      start = foldedCommand.indexOf(foldedNeedle, end);
    }
  }

  return results;
}

function resolveFullNoWorkspacePath(
  raw: string,
  cwd: string | undefined,
  home: string,
): string | null {
  let expanded = unquote(raw.trim()).replace(/\\/g, '/');
  const appData = `${home}/AppData/Roaming`;
  const replacements: Array<[RegExp, string]> = [
    [/^\$\{home\}(?=\/|$)/i, home],
    [/^\$home(?=\/|$)/i, home],
    [/^\$env:userprofile(?=\/|$)/i, home],
    [/^%userprofile%(?=\/|$)/i, home],
    [/^\$env:appdata(?=\/|$)/i, appData],
    [/^%appdata%(?=\/|$)/i, appData],
  ];
  for (const [pattern, value] of replacements) {
    if (pattern.test(expanded)) {
      expanded = expanded.replace(pattern, value);
      break;
    }
  }
  return resolvePath(expanded, cwd, home);
}

/** Resolve direct targets that need pathSafety hard-floor checks for the one
 * full-tier/no-workspace exception. Unresolved relative targets are omitted:
 * the scoped command sandbox still receives no ambient/global write grants. */
export function resolveFullNoWorkspaceCommandWriteTargets(
  command: string,
  cwd: string | undefined,
  home: string,
): string[] {
  const rawTargets = [
    ...extractFullNoWorkspaceWriteTargets(command),
    ...explicitAbuPathMentions(command, home),
  ];
  const resolved = new Set<string>();
  for (const raw of rawTargets) {
    const abs = resolveFullNoWorkspacePath(raw, cwd, home);
    if (abs) resolved.add(abs);
  }
  return Array.from(resolved);
}

/**
 * Decide whether a command writes outside the working directories.
 * Conservative: returns 'unknown' unless write targets are confidently resolved.
 */
export function analyzeCommandBoundary(
  command: string,
  cwd: string | undefined,
  home: string,
  scopeId?: AuthorizationScopeId,
): CmdBoundary {
  const targets = extractWriteTargets(command);
  if (targets.length === 0) return 'unknown';

  const dirs = scopeId === undefined
    ? allWorkingDirectories()
    : commandWritableDirectories(scopeId);
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
