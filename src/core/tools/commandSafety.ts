/**
 * Command Safety Module
 * Analyzes shell commands for potential dangers and provides safety levels
 */

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
  // Check for command chaining that might hide dangerous commands
  const injectionPatterns = [
    { pattern: /;\s*rm\s/, reason: '检测到命令注入: 分号后跟 rm' },
    { pattern: /\|\s*rm\s/, reason: '检测到命令注入: 管道后跟 rm' },
    { pattern: /&&\s*rm\s/, reason: '检测到命令注入: && 后跟 rm' },
    { pattern: /\|\|\s*rm\s/, reason: '检测到命令注入: || 后跟 rm' },
    { pattern: /\$\(.*rm\s/, reason: '检测到命令替换中的 rm' },
    { pattern: /`.*rm\s.*`/, reason: '检测到反引号中的 rm' },
    // No blanket backtick rule: substitution alone isn't dangerous (e.g. files=`ls`); dangerous content is caught by the specific rules.
    { pattern: /;\s*sudo\s/, reason: '检测到命令注入: 分号后跟 sudo' },
    { pattern: /\|\s*sudo\s/, reason: '检测到命令注入: 管道后跟 sudo' },
    { pattern: /eval\s/, reason: '检测到 eval 命令，可能执行任意代码' },
    { pattern: /\bexec\s/, reason: '检测到 exec 命令，可能替换当前进程' },
    { pattern: /source\s+\/dev\/tcp/, reason: '检测到网络反弹 shell' },
    { pattern: /\bsource\s+<\(/, reason: '检测到 process substitution 注入' },
    { pattern: /bash\s+-i/, reason: '检测到交互式 bash，可能是反弹 shell' },
    { pattern: /nc\s+.*-e/, reason: '检测到 netcat 反弹 shell' },
    { pattern: /python.*-c.*socket/, reason: '检测到 Python 反弹 shell' },
    { pattern: /python.*-c.*os\.system/, reason: '检测到 Python 执行系统命令' },
    { pattern: /python.*-c.*subprocess/, reason: '检测到 Python subprocess 调用' },
    { pattern: /perl.*-e.*system/, reason: '检测到 Perl 执行系统命令' },
    { pattern: /ruby.*-e.*system/, reason: '检测到 Ruby 执行系统命令' },
    { pattern: /\$\{?IFS\}?/, reason: '检测到 $IFS 变量替换，可能用于绕过安全检查' },
    { pattern: /\{[a-z]+,/, reason: '检测到 bash 花括号展开，可能用于绕过安全检查' },
    { pattern: /\$\{[^}]*[`$]/, reason: '检测到嵌套变量替换，可能用于绕过安全检查' },
    { pattern: />\s*\/dev\/tcp\//, reason: '检测到 /dev/tcp 网络重定向' },
    { pattern: /\|\s*base64\s+-d\s*\|/, reason: '检测到 base64 解码管道执行' },
    { pattern: /echo\s+.*\|\s*(ba)?sh/, reason: '检测到 echo 管道到 shell 执行' },
    { pattern: /printf\s+.*\|\s*(ba)?sh/, reason: '检测到 printf 管道到 shell 执行' },
  ];

  for (const { pattern, reason } of injectionPatterns) {
    if (pattern.test(command)) {
      return { injected: true, reason };
    }
  }

  // Windows-specific injection patterns (only checked on Windows)
  if (isWindows()) {
    const winInjectionPatterns = [
      { pattern: /[&|]\s*del\s/i, reason: '检测到命令注入: 管道/链接后跟 del' },
      { pattern: /[&|]\s*format\s/i, reason: '检测到命令注入: 管道/链接后跟 format' },
      { pattern: /&&\s*format\s/i, reason: '检测到命令注入: && 后跟 format' },
      { pattern: /powershell\s+.*-enc\b/i, reason: '检测到 PowerShell 编码命令，可能隐藏恶意操作' },
      { pattern: /powershell\s+.*-encodedcommand\b/i, reason: '检测到 PowerShell 编码命令' },
      { pattern: /powershell\s+.*-w\s+hidden/i, reason: '检测到 PowerShell 隐藏窗口执行' },
      { pattern: /powershell\s+.*-nop\b/i, reason: '检测到 PowerShell NoProfile 模式，可能绕过安全策略' },
      { pattern: /cmd\s+\/c\s+.*del\s/i, reason: '检测到 cmd /c 中的删除命令' },
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

const WIN_DANGEROUS_PATTERNS: Record<Exclude<DangerLevel, 'safe'>, Array<{ pattern: RegExp; reason: string }>> = {
  block: [
    { pattern: /del\s+\/s\s+\/q\s+[a-zA-Z]:\\/i, reason: '此命令会递归删除整个驱动器' },
    { pattern: /format\s+[a-zA-Z]:/i, reason: '此命令会格式化磁盘' },
    { pattern: /reg\s+delete\s+HKLM/i, reason: '此命令会删除系统注册表项' },
    { pattern: />\s*\\\\\.\\PhysicalDrive/i, reason: '此命令会覆盖物理磁盘数据' },
    { pattern: /diskpart/i, reason: '此命令可以修改磁盘分区' },
    { pattern: /bcdedit/i, reason: '此命令会修改系统引导配置' },
    { pattern: /cipher\s+\/w/i, reason: '此命令会安全擦除磁盘空闲空间' },
    { pattern: />\s*.*\\Microsoft\.PowerShell_profile\.ps1/i, reason: '禁止写入 PowerShell 配置文件' },
    { pattern: /rundll32\s+/i, reason: 'rundll32 可执行任意 DLL 代码' },
    { pattern: /regsvcs\s+/i, reason: 'regsvcs 可能用于 UAC 绕过' },
    { pattern: /regasm\s+/i, reason: 'regasm 可能用于代码执行绕过' },
    { pattern: /InstallUtil\s+/i, reason: 'InstallUtil 可能用于代码执行' },
    { pattern: /mavinject\s+/i, reason: 'mavinject 可进行 DLL 注入' },
    { pattern: /mshta\s+vbscript:/i, reason: 'mshta 内联 VBScript 执行' },
    { pattern: /mshta\s+javascript:/i, reason: 'mshta 内联 JavaScript 执行' },
    { pattern: /fodhelper/i, reason: 'fodhelper 可用于 UAC 绕过' },
    { pattern: /certutil\s+.*-encode/i, reason: 'certutil 编码可用于隐藏恶意文件' },
  ],
  danger: [
    { pattern: /del\s+\/s\b/i, reason: '递归删除命令，可能导致数据丢失' },
    { pattern: /rmdir\s+\/s\b/i, reason: '递归删除目录，可能导致数据丢失' },
    { pattern: /reg\s+delete\b/i, reason: '删除注册表项，可能影响系统稳定' },
    { pattern: /reg\s+export\b/i, reason: '导出注册表可能泄露敏感信息' },
    { pattern: /reg\s+save\b/i, reason: '保存注册表配置单元' },
    { pattern: /powershell\s+.*-executionpolicy\s+bypass/i, reason: '绕过 PowerShell 执行策略' },
    { pattern: /Invoke-WebRequest.*\|\s*iex/i, reason: '从网络下载并直接执行脚本' },
    { pattern: /Invoke-Expression/i, reason: '动态执行代码，可能存在安全风险' },
    { pattern: /IEX\s*\(/i, reason: '动态执行代码，可能存在安全风险' },
    { pattern: /certutil\s+.*-decode/i, reason: '解码隐藏文件，可能用于恶意目的' },
    { pattern: /certutil\s+.*-urlcache/i, reason: '通过 certutil 下载文件，可能绕过安全检测' },
    { pattern: /bitsadmin\s+.*\/transfer/i, reason: '通过 BITS 下载文件，可能绕过安全检测' },
    { pattern: /mshta\s+/i, reason: 'mshta 可执行远程脚本，存在安全风险' },
    { pattern: /wmic\s+.*process\s+call\s+create/i, reason: '通过 WMI 创建进程，可能绕过安全监控' },
    { pattern: /wmic\s+.*os\s+.*delete/i, reason: '通过 WMI 删除系统对象' },
    { pattern: /cscript.*\/\/e:jscript/i, reason: '通过 cscript 执行脚本，可能存在安全风险' },
    { pattern: /wscript.*\/\/e:jscript/i, reason: '通过 wscript 执行脚本，可能存在安全风险' },
    { pattern: /takeown\s+.*\/r/i, reason: '递归获取文件所有权，可能修改系统文件权限' },
    { pattern: /icacls\s+.*\/grant.*Everyone/i, reason: '授予所有人完全权限，存在安全风险' },
    { pattern: /netsh\s+.*wlan\s+.*key/i, reason: '可能导出 WiFi 密码' },
    { pattern: /vssadmin\s+delete\s+shadows/i, reason: '删除卷影副本' },
  ],
  warn: [
    { pattern: /del\s+/i, reason: '删除文件操作' },
    { pattern: /rmdir\s+/i, reason: '删除目录操作' },
    { pattern: /runas\s+/i, reason: '以其他用户身份运行' },
    { pattern: /taskkill\s+\/f/i, reason: '强制杀死进程' },
    { pattern: /net\s+stop\b/i, reason: '停止系统服务' },
    { pattern: /sc\s+delete\b/i, reason: '删除系统服务' },
    { pattern: /schtasks\s+\/delete/i, reason: '删除计划任务' },
    { pattern: /takeown\s+/i, reason: '获取文件所有权' },
    { pattern: /icacls\s+/i, reason: '修改文件权限' },
    { pattern: /reg\s+add\b/i, reason: '添加注册表项' },
    { pattern: /wmic\s+/i, reason: 'WMI 操作，请确认安全性' },
    { pattern: /netsh\s+.*firewall/i, reason: '修改防火墙规则' },
    { pattern: /netsh\s+.*advfirewall/i, reason: '修改高级防火墙规则' },
  ],
};

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
 * Dangerous command patterns organized by severity level
 */
const DANGEROUS_PATTERNS: Record<Exclude<DangerLevel, 'safe'>, Array<{ pattern: RegExp; reason: string }>> = {
  block: [
    // System-critical destructive commands
    { pattern: /rm\s+.*(-r\s+-f|-f\s+-r|-rf|-fr|--recursive)\s+\/$/, reason: '此命令会删除系统根目录' },
    { pattern: /rm\s+.*(-r\s+-f|-f\s+-r|-rf|-fr|--recursive)\s+~\/?$/, reason: '此命令会删除用户主目录' },
    { pattern: /rm\s+.*(-r\s+-f|-f\s+-r|-rf|-fr|--recursive)\s+\/\*/, reason: '此命令会删除根目录下所有文件' },
    { pattern: /rm\s+.*(-r\s+-f|-f\s+-r|-rf|-fr|--recursive)\s+~\/\*/, reason: '此命令会删除用户主目录下所有文件' },
    { pattern: /sudo\s+rm\s+.*(-r|-f|--recursive).*\/$/, reason: '此命令会以管理员权限删除根目录' },
    { pattern: />\s*\/dev\/sd[a-z]/, reason: '此命令会覆盖磁盘数据' },
    { pattern: />\s*\/dev\/nvme/, reason: '此命令会覆盖 NVMe 磁盘数据' },
    { pattern: /dd\s+.*of=\/dev\//, reason: '此命令会直接写入磁盘设备' },
    { pattern: /mkfs\./, reason: '此命令会格式化文件系统' },
    { pattern: /:\s*\(\)\s*\{/, reason: '这是 fork 炸弹，会耗尽系统资源' },
    { pattern: />\s*\/dev\/null\s*2>&1\s*&/, reason: '可疑的后台静默执行' },
    // Prevent reading/writing sensitive files via commands
    { pattern: /cat\s+.*\.ssh\/id_/, reason: '禁止读取 SSH 私钥' },
    { pattern: /cat\s+.*\.aws\/credentials/, reason: '禁止读取 AWS 凭证' },
    { pattern: />\s*.*\.ssh\/authorized_keys/, reason: '禁止写入 SSH 授权密钥' },
    { pattern: />\s*.*\.bashrc/, reason: '禁止写入 shell 配置文件' },
    { pattern: />\s*.*\.zshrc/, reason: '禁止写入 shell 配置文件' },
    { pattern: />\s*.*\.profile/, reason: '禁止写入 shell 配置文件' },
  ],
  danger: [
    // Destructive but may be intentional (with various flag combinations)
    { pattern: /rm\s+.*(-r|-R|--recursive)/, reason: '递归删除命令，可能导致数据丢失' },
    { pattern: /rm\s+.*\*/, reason: '通配符删除命令，可能删除意外文件' },
    { pattern: /git\s+push\s+.*(-f|--force)/, reason: '强制推送可能覆盖远程历史记录' },
    { pattern: /git\s+reset\s+--hard/, reason: '硬重置会丢弃所有未提交的更改' },
    { pattern: /git\s+clean\s+.*-f/, reason: '会删除所有未跟踪的文件' },
    { pattern: /git\s+checkout\s+--\s*\.$/, reason: '会丢弃所有未暂存的更改' },
    { pattern: /chmod\s+777/, reason: '设置完全开放权限存在安全风险' },
    { pattern: /chmod\s+-R\s+777/, reason: '递归设置完全开放权限，风险极高' },
    { pattern: /curl.*\|\s*(ba)?sh/, reason: '从网络下载并直接执行脚本存在安全风险' },
    { pattern: /wget.*\|\s*(ba)?sh/, reason: '从网络下载并直接执行脚本存在安全风险' },
    { pattern: /curl.*\|\s*python/, reason: '从网络下载并直接执行 Python 脚本' },
    { pattern: /pip\s+install.*--break-system-packages/, reason: '可能破坏系统 Python 环境' },
    { pattern: /npm\s+.*--force/, reason: '强制安装可能绕过安全检查' },
    { pattern: /bash\s+-c\s+["'].*rm\s/, reason: 'bash -c 中包含删除命令' },
    { pattern: /sh\s+-c\s+["'].*rm\s/, reason: 'sh -c 中包含删除命令' },
    { pattern: /xargs\s+.*rm/, reason: 'xargs 与 rm 组合可能批量删除' },
    { pattern: /find\s+.*-delete/, reason: 'find -delete 可能批量删除文件' },
    { pattern: /find\s+.*-exec\s+rm/, reason: 'find -exec rm 可能批量删除文件' },
  ],
  warn: [
    // Common commands that should be confirmed
    { pattern: /sudo\s+/, reason: '需要管理员权限' },
    { pattern: /rm\s+/, reason: '删除文件操作' },
    { pattern: /git\s+push/, reason: '推送代码到远程仓库' },
    { pattern: /npm\s+publish/, reason: '发布 npm 包到公共仓库' },
    { pattern: /brew\s+uninstall/, reason: '卸载 Homebrew 软件包' },
    { pattern: /pip\s+uninstall/, reason: '卸载 Python 包' },
    { pattern: /apt\s+remove/, reason: '卸载系统软件包' },
    { pattern: /apt-get\s+remove/, reason: '卸载系统软件包' },
    { pattern: /apt\s+purge/, reason: '完全卸载系统软件包' },
    { pattern: /yum\s+remove/, reason: '卸载系统软件包' },
    { pattern: /dnf\s+remove/, reason: '卸载系统软件包' },
    { pattern: /mv\s+.*\/dev\/null/, reason: '将文件移动到 /dev/null 会导致数据丢失' },
    { pattern: /truncate\s+/, reason: '截断文件可能导致数据丢失' },
    { pattern: /shred\s+/, reason: '安全擦除文件，不可恢复' },
    { pattern: /kill\s+-9/, reason: '强制杀死进程' },
    { pattern: /killall\s+/, reason: '杀死所有匹配进程' },
    { pattern: /pkill\s+/, reason: '杀死匹配进程' },
    { pattern: /systemctl\s+(stop|disable|mask)/, reason: '停止或禁用系统服务' },
    { pattern: /launchctl\s+(unload|remove)/, reason: '卸载 macOS 服务' },
  ],
};

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
 * Analyze a command string and return its danger level
 */
export function analyzeCommand(command: string): CommandAnalysis {
  const trimmedCommand = command.trim();
  const normalizedCommand = normalizeCommand(trimmedCommand);

  // Compute read-only status upfront (used for concurrency safety, does NOT affect danger level)
  const readOnly = isReadOnlyCommand(trimmedCommand);

  // Check for command injection first
  const injectionCheck = hasCommandInjection(trimmedCommand);
  if (injectionCheck.injected) {
    return { level: 'danger', reason: injectionCheck.reason, readOnly: false };
  }

  // Build platform-aware pattern lists
  const safePatterns = isWindows() ? [...SAFE_PATTERNS, ...WIN_SAFE_PATTERNS] : SAFE_PATTERNS;

  // Check safe patterns first (use original command for safe patterns)
  for (const pattern of safePatterns) {
    if (pattern.test(trimmedCommand)) {
      return { level: 'safe', reason: '', readOnly };
    }
  }

  // Check dangerous patterns in order of severity
  // Check both original and normalized command to catch obfuscation
  const levels: Array<Exclude<DangerLevel, 'safe'>> = ['block', 'danger', 'warn'];

  for (const level of levels) {
    // Merge Windows patterns when on Windows
    const patterns = isWindows()
      ? [...DANGEROUS_PATTERNS[level], ...WIN_DANGEROUS_PATTERNS[level]]
      : DANGEROUS_PATTERNS[level];

    for (const { pattern, reason } of patterns) {
      if (pattern.test(trimmedCommand) || pattern.test(normalizedCommand)) {
        return {
          level,
          reason,
          matchedPattern: pattern.source,
          readOnly: false,
        };
      }
    }
  }

  // Default to safe for unmatched commands
  return { level: 'safe', reason: '', readOnly };
}

/**
 * Get a human-readable description for a danger level
 */
export function getDangerLevelLabel(level: DangerLevel): string {
  switch (level) {
    case 'block':
      return '已阻止';
    case 'danger':
      return '危险操作';
    case 'warn':
      return '需要确认';
    case 'safe':
      return '安全';
  }
}
