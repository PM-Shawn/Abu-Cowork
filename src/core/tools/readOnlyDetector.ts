/**
 * Read-Only Command Detector
 *
 * Identifies shell commands that only read data and have no side effects.
 * Used for:
 * - Concurrency safety: read-only commands can run in parallel
 * - UI hints: show "safe command" badge in confirmation dialogs
 *
 * IMPORTANT: This module is purely informational — it does NOT bypass the
 * existing confirmation flow. Even if a command is classified as read-only,
 * the user's permission mode determines whether confirmation is shown.
 */

import { isWindows } from '../../utils/platform';

/**
 * Unix/macOS commands that only read data.
 * Each regex matches the command at the START of a pipeline segment.
 */
const UNIX_READ_ONLY: RegExp[] = [
  // File/directory inspection
  /^ls\b/, /^cat\b/, /^head\b/, /^tail\b/, /^wc\b/, /^file\b/,
  /^stat\b/, /^du\b/, /^df\b/, /^md5\b/, /^shasum\b/, /^sha256sum\b/,
  /^xxd\b/, /^hexdump\b/, /^strings\b/, /^readlink\b/,

  // Search
  /^grep\b/, /^egrep\b/, /^fgrep\b/, /^rg\b/, /^ag\b/, /^fd\b/,
  /^find\b(?!.*-delete)(?!.*-exec\s+rm)/,

  // System info
  /^which\b/, /^where\b/, /^type\b/, /^echo\b/, /^printf\b/, /^pwd\b/,
  /^date\b/, /^whoami\b/, /^id\b/, /^uname\b/, /^hostname\b/, /^uptime\b/,
  /^sw_vers\b/, /^arch\b/, /^sysctl\b/,

  // Environment
  /^env\b/, /^printenv\b/, /^set\b/, /^export\b/,
  /^locale\b/, /^ulimit\b/,

  // Process inspection
  /^ps\b/, /^top\s+-l\s+1\b/, /^pgrep\b/, /^lsof\b/,

  // Network inspection (read-only)
  /^dig\b/, /^nslookup\b/, /^host\b/, /^ping\s+-c\b/, /^traceroute\b/,
  /^ifconfig\b/, /^ip\s+(addr|route|link)\b/, /^netstat\b/, /^ss\b/,

  // Version checks
  /^node\s+(-v|--version)\b/, /^npm\s+(-v|--version)\b/,
  /^python3?\s+(-V|--version)\b/, /^java\s+(-version|--version)\b/,
  /^go\s+version\b/, /^rustc\s+--version\b/, /^cargo\s+--version\b/,
  /^ruby\s+(-v|--version)\b/, /^php\s+(-v|--version)\b/,
  /^git\s+--version\b/, /^gcc\s+--version\b/,

  // Git read-only
  /^git\s+(status|log|diff|show|branch|tag|remote|rev-parse|describe|shortlog|blame|ls-files|ls-tree|cat-file|rev-list|name-rev)\b/,

  // npm/yarn read-only
  /^npm\s+(list|ls|outdated|view|info|search|pack\s+--dry-run|audit|config\s+(list|get)|why|explain)\b/,
  /^yarn\s+(list|outdated|info|why)\b/,

  // Text processing (pure functions, no side effects)
  /^sort\b/, /^uniq\b/, /^cut\b/, /^tr\b/, /^awk\b/, /^sed\s+-n\b/,
  /^column\b/, /^paste\b/, /^comm\b/, /^diff\b/, /^cmp\b/,
  /^jq\b/, /^yq\b/, /^xmllint\b/,

  // Pager/viewer
  /^less\b/, /^more\b/, /^bat\b/,

  // Tree view
  /^tree\b/, /^exa\b/, /^eza\b/,

  // Disk/system info
  /^diskutil\s+(list|info)\b/, /^system_profiler\b/,
  /^defaults\s+read\b/,
];

/**
 * Windows/PowerShell commands that only read data.
 */
const WIN_READ_ONLY: RegExp[] = [
  /^dir\b/i, /^type\b/i, /^where\b/i, /^echo\b/i,
  /^hostname\b/i, /^ipconfig\b/i, /^whoami\b/i,
  /^systeminfo\b/i, /^findstr\b/i, /^tree\b/i,
  /^more\b/i, /^fc\b/i, /^ver\b/i, /^path\b/i,
  /^tasklist\b/i, /^set\b/i, /^cls\b/i,
  /^Get-Content\b/i, /^Get-ChildItem\b/i, /^Get-Item\b/i,
  /^Get-Process\b/i, /^Get-Service\b/i, /^Get-Date\b/i,
  /^Get-Location\b/i, /^Get-Command\b/i, /^Get-Help\b/i,
  /^Get-Module\b/i, /^Get-Package\b/i,
  /^Select-String\b/i, /^Measure-Object\b/i,
  /^Test-Path\b/i, /^Test-Connection\b/i,
  /^Format-List\b/i, /^Format-Table\b/i,
];

/**
 * Patterns that indicate write/side-effect operations within a command segment.
 * If ANY of these match, the segment is NOT read-only.
 */
const WRITE_INDICATORS: RegExp[] = [
  // Output redirection (but not stderr-to-stdout 2>&1)
  /(?<![2&])>\s*[^&]/, // > file (but not 2>&1)
  />>/,                 // >> file (append)

  // Destructive commands embedded
  /\brm\s/, /\brmdir\s/, /\bdel\s/i, /\bmkdir\s/, /\btouch\s/,
  /\bmv\s/, /\bcp\s/, /\bchmod\s/, /\bchown\s/,
  /\bsudo\s/, /\bkill\s/, /\bpkill\s/, /\bkillall\s/,
  /\btee\s/, // tee writes to file

  // Package management (write operations)
  /\bnpm\s+install\b/, /\bnpm\s+uninstall\b/, /\bnpm\s+update\b/,
  /\bpip\s+install\b/, /\bpip\s+uninstall\b/,
  /\bbrew\s+install\b/, /\bbrew\s+uninstall\b/,

  // Git write operations
  /\bgit\s+(push|commit|merge|rebase|reset|checkout|stash|cherry-pick|revert|pull|fetch|clone|init|add)\b/,
];

/**
 * Split a compound command into individual segments.
 * Handles: &&, ||, ;, | (pipe), and a single shell background separator `&`.
 *
 * Note: Pipes are tricky — `grep foo | sort` is read-only, but
 * `grep foo | tee output.txt` is not. We check each segment individually.
 */
function splitCommandSegments(command: string): string[] {
  // A single `&` is a command boundary too. Do not split fd redirects such as
  // `2>&1`, `<&3`, or `&>file`; those are handled by the redirect checks.
  // This is not a full parser, but covers common cases
  return command
    .split(/\s*(?:&&|\|\||;|\||(?<![&<>])&(?![&>]))\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Check if a command string is read-only (no side effects).
 *
 * Analyzes the full command including pipes, chains, and subshells.
 * Returns true only if ALL segments are recognized read-only commands
 * and no write indicators are present.
 */
export function isReadOnlyCommand(command: string): boolean {
  if (!command || !command.trim()) return true; // empty command is "safe"

  const trimmed = command.trim();

  // Quick check: if the entire command has write indicators, bail immediately
  for (const indicator of WRITE_INDICATORS) {
    if (indicator.test(trimmed)) return false;
  }

  // Check for subshell / command substitution — be conservative
  if (/\$\(/.test(trimmed) || /`[^`]+`/.test(trimmed)) {
    return false;
  }

  // Split into segments and check each one
  const segments = splitCommandSegments(trimmed);
  if (segments.length === 0) return true;

  const readOnlyPatterns = isWindows()
    ? [...UNIX_READ_ONLY, ...WIN_READ_ONLY]
    : UNIX_READ_ONLY;

  for (const segment of segments) {
    // Check if this segment matches a known read-only pattern
    const isKnownReadOnly = readOnlyPatterns.some(p => p.test(segment));
    if (!isKnownReadOnly) return false;
  }

  return true;
}
