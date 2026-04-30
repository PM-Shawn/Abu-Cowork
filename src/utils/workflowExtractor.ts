import type { ToolCall, AgentStatus } from '@/types';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { normalizeSeparators, joinPath, getBaseName } from '@/utils/pathUtils';
import { parseArgs } from '@/utils/argsParser';

/**
 * Check if a tool result indicates a real tool execution error.
 * Matches results starting with "Error:" or "Error " (e.g. "Error reading file:") —
 * NOT incidental "error" mentions in content (e.g. "Console: 11 errors" from Playwright).
 */
export function isToolResultError(result: string): boolean {
  const trimmed = result.trimStart();
  return trimmed.startsWith('Error:') || trimmed.startsWith('Error ');
}

// Workflow step types
export type StepType = 'thinking' | 'tool' | 'skill' | 'file-read' | 'file-write' | 'file-create' | 'command';

export interface WorkflowStep {
  id: string;
  type: StepType;
  label: string;       // Display text, e.g., "读取 App.tsx"
  detail?: string;     // Detailed info, e.g., full path
  status: 'pending' | 'running' | 'completed' | 'error';
  timestamp: number;
  duration?: number;   // Duration in seconds (for thinking/tool execution)
  // Tool call data for collapsible details
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
}

// Skill info passed from message
export interface SkillInfo {
  name: string;
  description?: string;
}

// Tool name to step type mapping
const FILE_READ_TOOLS: string[] = [TOOL_NAMES.READ_FILE, 'read', 'get_file_contents'];
const FILE_WRITE_TOOLS: string[] = [TOOL_NAMES.WRITE_FILE, TOOL_NAMES.EDIT_FILE, 'write', 'edit'];
const FILE_CREATE_TOOLS: string[] = ['create_file', 'create'];
const COMMAND_TOOLS: string[] = [TOOL_NAMES.RUN_COMMAND, 'bash', 'execute', 'shell'];
const SKILL_TOOLS: string[] = [TOOL_NAMES.USE_SKILL];

function getStepTypeFromTool(toolName: string): StepType {
  if (FILE_READ_TOOLS.includes(toolName)) return 'file-read';
  if (FILE_WRITE_TOOLS.includes(toolName)) return 'file-write';
  if (FILE_CREATE_TOOLS.includes(toolName)) return 'file-create';
  if (COMMAND_TOOLS.includes(toolName)) return 'command';
  if (SKILL_TOOLS.includes(toolName)) return 'skill';
  return 'tool';
}

// Extract filename from path
function getFileName(path: string): string {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

// Get display label for tool call
function getToolLabel(toolName: string, input: Record<string, unknown>): { label: string; detail?: string } {
  const path = (input.path || input.file_path || input.filePath) as string | undefined;
  const fileName = path ? getFileName(path) : undefined;

  switch (toolName) {
    case TOOL_NAMES.READ_FILE:
    case 'read':
    case 'get_file_contents':
      return {
        label: fileName ? `读取 ${fileName}` : '读取文件',
        detail: path,
      };
    case TOOL_NAMES.WRITE_FILE:
    case 'write':
      return {
        label: fileName ? `写入 ${fileName}` : '写入文件',
        detail: path,
      };
    case TOOL_NAMES.EDIT_FILE:
    case 'edit':
      return {
        label: fileName ? `修改 ${fileName}` : '修改文件',
        detail: path,
      };
    case 'create_file':
    case 'create':
      return {
        label: fileName ? `创建 ${fileName}` : '创建文件',
        detail: path,
      };
    case 'bash':
    case TOOL_NAMES.RUN_COMMAND:
    case 'execute':
    case 'shell': {
      const cmd = (input.command || input.cmd) as string | undefined;
      const shortCmd = cmd ? (cmd.length > 20 ? cmd.slice(0, 20) + '...' : cmd) : undefined;
      return {
        label: shortCmd ? `执行 ${shortCmd}` : '执行命令',
        detail: cmd,
      };
    }
    case 'search':
    case 'grep':
    case 'find': {
      const query = (input.query || input.pattern) as string | undefined;
      return {
        label: query ? `搜索 "${query.slice(0, 15)}${query.length > 15 ? '...' : ''}"` : '搜索',
        detail: query,
      };
    }
    case TOOL_NAMES.USE_SKILL: {
      const skillName = input.skill_name as string | undefined;
      return {
        label: skillName ? `使用技能 ${skillName}` : '使用技能',
        detail: input.context as string | undefined,
      };
    }
    default:
      return {
        label: `调用 ${toolName}`,
        detail: undefined,
      };
  }
}

/**
 * Extract workflow steps from tool calls, thinking, and agent status
 */
export function extractWorkflowSteps(
  toolCalls: ToolCall[],
  thinking?: string,
  agentStatus?: AgentStatus,
  skillInfo?: SkillInfo,
  thinkingDuration?: number
): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  const now = Date.now();

  // Add skill step first if a skill was triggered
  if (skillInfo) {
    const hasCompletedTools = toolCalls.some((tc) => tc.result !== undefined);
    const isExecuting = toolCalls.some((tc) => tc.isExecuting);

    steps.push({
      id: 'skill',
      type: 'skill',
      label: `使用 /${skillInfo.name} 技能`,
      detail: skillInfo.description,
      status: hasCompletedTools ? 'completed' : isExecuting ? 'running' : 'pending',
      timestamp: now - 2000,
    });
  }

  // Add thinking step if exists
  if (thinking) {
    steps.push({
      id: 'thinking',
      type: 'thinking',
      label: '思考中...',
      detail: thinking,
      // Treat the step as still running until the thinking phase actually ends.
      // thinkingDuration is set in agentLoop on the thinking → text/tool transition,
      // so its presence is the canonical signal that thinking is done.
      status: thinkingDuration ? 'completed' : 'running',
      timestamp: now - 1000,
      duration: thinkingDuration,
    });
  } else if (agentStatus === 'thinking') {
    // Currently thinking but no content yet
    steps.push({
      id: 'thinking',
      type: 'thinking',
      label: '思考中...',
      status: 'running',
      timestamp: now,
    });
  }

  // Add steps from tool calls
  for (const tc of toolCalls) {
    // Skip use_skill tool - we already show skill at the top
    if (tc.name === TOOL_NAMES.USE_SKILL) {
      // Extract skill name and add as a skill step
      const skillName = tc.input.skill_name as string | undefined;
      if (skillName) {
        let status: WorkflowStep['status'];
        if (tc.isExecuting) {
          status = 'running';
        } else if (tc.result !== undefined) {
          status = tc.result.toLowerCase().includes('error') ? 'error' : 'completed';
        } else {
          status = 'pending';
        }

        steps.push({
          id: tc.id,
          type: 'skill',
          label: `使用 /${skillName} 技能`,
          detail: tc.input.context as string | undefined,
          status,
          timestamp: now,
          toolName: tc.name,
          toolInput: tc.input,
          toolResult: tc.result,
        });
      }
      continue;
    }

    const stepType = getStepTypeFromTool(tc.name);
    const { label, detail } = getToolLabel(tc.name, tc.input);

    let status: WorkflowStep['status'];
    if (tc.isExecuting) {
      status = 'running';
    } else if (tc.result !== undefined) {
      // Check if result indicates a real tool execution error (prefix match, not full-text search)
      status = isToolResultError(tc.result) ? 'error' : 'completed';
    } else {
      status = 'pending';
    }

    steps.push({
      id: tc.id,
      type: stepType,
      label,
      detail,
      status,
      timestamp: now,
      toolName: tc.name,
      toolInput: tc.input,
      toolResult: tc.result,
    });
  }

  return steps;
}

/**
 * Generate friendly completion message for a tool call
 */
export function generateCompletionMessage(
  toolName: string,
  input: Record<string, unknown>,
  result: string,
  locale: string = 'zh',
  _executionTime?: number
): string {
  const isZh = locale.startsWith('zh');
  const path = (input.path || input.file_path || input.filePath) as string | undefined;
  const fileName = path ? getFileName(path) : undefined;

  // Parse result for additional info
  const parseFileCount = (res: string): number => {
    // Try to count items in a directory listing
    const lines = res.split('\n').filter((l) => l.trim());
    return lines.length;
  };

  const isSuccess = !isToolResultError(result);

  switch (toolName) {
    case TOOL_NAMES.LIST_DIRECTORY: {
      const count = parseFileCount(result);
      return isZh
        ? `成功列出 ${count} 个文件和文件夹`
        : `Listed ${count} files and folders`;
    }

    case TOOL_NAMES.READ_FILE:
    case 'read':
    case 'get_file_contents':
      if (!isSuccess) {
        return isZh ? `读取失败` : `Failed to read`;
      }
      return isZh
        ? `成功读取 ${fileName || '文件'}`
        : `Read ${fileName || 'file'} successfully`;

    case TOOL_NAMES.WRITE_FILE:
    case 'write':
      if (!isSuccess) {
        return isZh ? `写入失败` : `Failed to write`;
      }
      return isZh
        ? `成功写入 ${fileName || '文件'}`
        : `Wrote to ${fileName || 'file'} successfully`;

    case TOOL_NAMES.EDIT_FILE:
    case 'edit':
      if (!isSuccess) {
        return isZh ? `修改失败` : `Failed to edit`;
      }
      return isZh
        ? `成功修改 ${fileName || '文件'}`
        : `Edited ${fileName || 'file'} successfully`;

    case 'create_file':
    case 'create':
      if (!isSuccess) {
        return isZh ? `创建失败` : `Failed to create`;
      }
      return isZh
        ? `成功创建 ${fileName || '文件'}`
        : `Created ${fileName || 'file'} successfully`;

    case TOOL_NAMES.RUN_COMMAND:
    case 'bash':
    case 'execute':
    case 'shell': {
      const cmd = (input.command || input.cmd) as string | undefined;
      const shortCmd = cmd ? (cmd.length > 15 ? cmd.slice(0, 15) + '...' : cmd) : '';
      if (!isSuccess) {
        return isZh ? `执行失败` : `Command failed`;
      }
      return isZh
        ? `命令执行成功${shortCmd ? `：${shortCmd}` : ''}`
        : `Command executed${shortCmd ? `: ${shortCmd}` : ''} successfully`;
    }

    case TOOL_NAMES.GET_SYSTEM_INFO:
      return isZh ? `获取系统信息成功` : `Got system info`;

    case 'search':
    case 'grep':
    case 'find': {
      const matchCount = result.split('\n').filter((l) => l.trim()).length;
      return isZh
        ? `搜索完成，找到 ${matchCount} 条结果`
        : `Search complete, found ${matchCount} results`;
    }

    case TOOL_NAMES.MANAGE_SCHEDULED_TASK: {
      const action = (input.action as string) || '';
      const taskName = (input.name as string) || '';
      if (!isSuccess) return isZh ? '操作失败' : 'Operation failed';
      const msgs: Record<string, string> = {
        create: isZh ? `成功创建定时任务${taskName ? `「${taskName}」` : ''}` : 'Created scheduled task',
        list: isZh ? '已列出定时任务' : 'Listed scheduled tasks',
        update: isZh ? '成功更新定时任务' : 'Updated scheduled task',
        delete: isZh ? '成功删除定时任务' : 'Deleted scheduled task',
        pause: isZh ? '已暂停定时任务' : 'Paused scheduled task',
        resume: isZh ? '已恢复定时任务' : 'Resumed scheduled task',
      };
      return msgs[action] || (isZh ? '操作成功' : 'Completed');
    }

    default:
      return isZh
        ? isSuccess ? `执行成功` : '执行失败'
        : isSuccess ? `Completed successfully` : 'Failed';
  }
}

// ── File output extraction helpers ──

/** Extensions for scripts that may be intermediate build artifacts */
const SCRIPT_EXTENSIONS = new Set([
  'py', 'js', 'ts', 'sh', 'bash', 'rb', 'pl', 'lua',
  'r', 'bat', 'ps1', 'cmd', 'zsh', 'fish',
]);

export type FileOutput = { path: string; operation: 'read' | 'write' | 'create' };

/**
 * Extract stdout content from run_command result format:
 *   stdout:\n{content}\n\nstderr:\n{content}\n\nexit code: {code}
 */
export function extractStdout(result: string): string {
  const stdoutMatch = result.match(/^stdout:\n([\s\S]*?)(?:\n\nstderr:|\n\nexit code:)/);
  if (stdoutMatch) return stdoutMatch[1];
  return '';
}

/**
 * Check if a command result indicates failure (non-zero exit code).
 * Handles the run_command result format: "...\n\nexit code: N"
 */
function isCommandFailed(result: string): boolean {
  const exitMatch = result.match(/exit code:\s*(\d+)/);
  if (exitMatch) return exitMatch[1] !== '0';
  // Also check for sandbox-blocked results
  if (result.includes('[sandbox-blocked]')) return true;
  return false;
}

/** Check if a path has a file extension (guard against directory paths) */
function hasFileExtension(path: string): boolean {
  return /\.\w{1,10}$/.test(path);
}

/** Check if a command is read-only (should not extract file paths as outputs) */
function isReadOnlyCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  const readPatterns = [
    /^(python3?|python)\s+(-\w\s+)*-m\s+markitdown\b/,
    /^cat\s+(?!.*>)/,
    /^(head|tail|less|more)\b/,
    /^ls\b/,
    /^file\b/,
    /^stat\b/,
    /^wc\b/,
    /^unzip\s+-[ltv]/,
  ];
  return readPatterns.some(p => p.test(trimmed));
}

/**
 * Document extensions that count as user-facing deliverables.
 *
 * Used by 'deliverables' mode (chat message cards + output snapshots) to
 * keep cards focused on artifacts the user actually cares about, filtering
 * out scripts, logs, and other intermediate files.
 *
 * 2026-04-30: added md/txt/json/yaml/yml. Triggered by user report — the
 * todo skill writes 2026-04-XX.md via run_command, but .md wasn't in the
 * whitelist so file cards never appeared. The four added extensions are
 * common user-readable artifacts (notes, data dumps, configs intentionally
 * exported by the agent).
 */
const DOCUMENT_EXTENSIONS = new Set([
  // Office / media (high-confidence binary deliverables)
  'pptx', 'ppt', 'docx', 'doc', 'pdf', 'xlsx', 'xls', 'csv',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'html', 'htm',
  // User-readable text artifacts
  'md', 'txt',
  // Data exports / configs
  'json', 'yaml', 'yml',
]);

/**
 * Extensions explicitly excluded from 'file-ops' mode as noise.
 *
 * file-ops doesn't apply a positive whitelist (the user wants transparency
 * into what files the AI touched), but we do filter out a small set of
 * "this is process noise, not a file the user cares about" extensions.
 *
 * Conservative list — only extensions that are *almost always* operational
 * artifacts the user has no reason to inspect.
 */
const NOISE_EXTENSIONS = new Set([
  'log', 'tmp', 'bak', 'cache', 'lock', 'pid',
]);

/**
 * Two semantics that previously shared one extraction pipeline:
 *
 *  - 'deliverables' — "what did the AI deliver this turn?"
 *      Strict DOCUMENT_EXTENSIONS whitelist. Filters scripts that were
 *      later executed (intermediate artifacts). Used by chat message
 *      cards and outputSnapshots.
 *
 *  - 'file-ops' — "what files did this conversation touch?"
 *      No extension whitelist (any extension OK), only filters obvious
 *      noise. Doesn't filter executed scripts (the user wants to see
 *      what the AI ran). Used by RightPanel's audit view.
 */
export type ExtractMode = 'deliverables' | 'file-ops';

/**
 * Parse a simple `mv` / `cp` command and return its {sources, destination}.
 *
 * Why this exists: the generic extractDocumentPathsFromCommand() was designed
 * for single-output commands like `python gen.py /tmp/out.xlsx` — it regex-
 * matches any absolute path with a document extension. But `mv a.xlsx b.xlsx`
 * is a structurally different shape: two paths with the *same basename* but
 * opposite semantics. The generic extractor returns them in left-to-right
 * order, and the caller dedupes by basename (first wins), so the *source*
 * path survives — pointing at a file that no longer exists after the move.
 *
 * This parser carves out a semantic fast-path for mv/cp: we recognize the
 * verb, tokenize argv with parseArgs (quotes/escapes), strip flags, and
 * return (sources[], destination). The caller then maps each source to its
 * final destination path and records only that.
 *
 * Returns null — and lets the generic extractor take over — when the command
 * contains pipes, redirects, subshells, logical operators, or too few args.
 * We stay conservative on purpose: misclassifying a complex shell construct
 * as a simple move is worse than falling back.
 *
 * Intentionally NOT handled:
 *   - GNU `-t DEST` (target-first) — rare in AI-generated commands
 *   - `rename` — Perl and util-linux versions have incompatible syntaxes
 *   - `rsync`, `install`, `ln` — different semantics, add later if needed
 */
function parseCopyMoveCommand(cmd: string): { sources: string[]; destination: string } | null {
  const trimmed = cmd.trim();
  // Must start with mv or cp as the literal first token
  if (!/^(mv|cp)\b/.test(trimmed)) return null;
  // Bail on any shell construct that makes "the rest is argv to mv/cp" false:
  //   | pipe, ; sequence, && || logic, > < redirect, $(…) subshell, `…` backtick
  if (/[|;<>`]|&&|\|\||\$\(/.test(trimmed)) return null;

  // Drop the verb, tokenize the rest via the shared argv parser
  const afterVerb = trimmed.replace(/^(mv|cp)\s+/, '');
  const tokens = parseArgs(afterVerb);
  // Strip flags (e.g. -f, -v, -r, --verbose). GNU `--target-directory=...` is
  // also dropped — we treat it as opaque flag and fall through by returning null
  // if what's left is insufficient.
  const nonFlags = tokens.filter((t) => !t.startsWith('-'));
  if (nonFlags.length < 2) return null;

  return {
    sources: nonFlags.slice(0, -1),
    destination: nonFlags[nonFlags.length - 1],
  };
}

/**
 * Extract file paths from a shell command string.
 *
 * Mode controls which extensions count:
 *   - 'deliverables': only DOCUMENT_EXTENSIONS (strict whitelist)
 *   - 'file-ops': any extension except NOISE_EXTENSIONS (transparency)
 */
function extractPathsFromCommand(cmd: string, mode: ExtractMode): string[] {
  const paths: string[] = [];
  const accept = (ext: string): boolean => {
    const lower = ext.toLowerCase();
    if (mode === 'deliverables') return DOCUMENT_EXTENSIONS.has(lower);
    // file-ops: accept any extension that isn't noise
    return !NOISE_EXTENSIONS.has(lower);
  };

  // Match quoted paths
  const quotedRegex = /["']((?:\/|~\/)[^"'\n]+\.(\w{1,10}))["']/g;
  let match: RegExpExecArray | null;
  while ((match = quotedRegex.exec(cmd)) !== null) {
    if (accept(match[2])) paths.push(match[1]);
  }
  // Match unquoted absolute paths
  if (paths.length === 0) {
    const unquotedRegex = /(?:^|\s)((?:\/|~\/)\S+\.(\w{1,10}))(?:\s|$)/g;
    while ((match = unquotedRegex.exec(cmd)) !== null) {
      if (accept(match[2])) paths.push(match[1]);
    }
  }
  return paths;
}

/**
 * Extract file paths from text output (stdout, delegate results, etc.)
 * Matches common Chinese/English patterns for file output announcements.
 *
 * Supports paths with spaces when wrapped in quotes/backticks (e.g. ~/Library/Application Support/...)
 * — the quoted-form patterns run first and take precedence.
 */
export function extractFilePathsFromText(text: string): string[] {
  const paths = new Set<string>();

  // Pattern groups, ordered: quoted-form first (allows spaces), then bare form.
  const patterns: RegExp[] = [
    // ── Quoted forms (allow spaces in path) ──
    // Backtick-quoted: 文件位置: `path with spaces.ext`
    /(?:已保存到|已保存|输出到|写入到|生成到|导出到|已创建|已生成|生成了|生成完成|创建了|创建于|Output file|输出文件|文件位置|文件路径|保存在|保存到|saved to|output to|written to|exported to|generated at|created at|created)\s*[:：]?\s*`([^`\n]+\.\w{1,10})`/gi,
    // Single-quoted: 文件位置: 'path with spaces.ext'
    /(?:已保存到|已保存|输出到|写入到|生成到|导出到|已创建|已生成|生成了|生成完成|创建了|创建于|Output file|输出文件|文件位置|文件路径|保存在|保存到|saved to|output to|written to|exported to|generated at|created at|created)\s*[:：]?\s*'([^'\n]+\.\w{1,10})'/gi,
    // Double-quoted: 文件位置: "path with spaces.ext"
    /(?:已保存到|已保存|输出到|写入到|生成到|导出到|已创建|已生成|生成了|生成完成|创建了|创建于|Output file|输出文件|文件位置|文件路径|保存在|保存到|saved to|output to|written to|exported to|generated at|created at|created)\s*[:：]?\s*"([^"\n]+\.\w{1,10})"/gi,

    // ── Bare forms (no spaces allowed) ──
    // Chinese: 已保存到 /path/to/file.ext
    /(?:已保存到|已保存|输出到|写入到|生成到|导出到|已创建|已生成|生成了|生成完成|创建了|创建于)\s*[:：]?\s*((?:[A-Za-z]:\\|\/|~\/)[^\s"'`,，。、;；\n]+)/g,
    // English: saved to /path/to/file.ext
    /(?:saved to|output to|written to|exported to|generated at|created at|created)\s*[:：]?\s*((?:[A-Za-z]:\\|\/|~\/)[^\s"'`,，。、;；\n]+)/gi,
    // Label: Output file: /path  or  输出文件: /path  or  文件位置: /path
    /(?:Output file|输出文件|文件位置|文件路径|保存在|保存到)\s*[:：]\s*((?:[A-Za-z]:\\|\/|~\/|[^\s"'`,，。、;；\n/\\])[^\s"'`,，。、;；\n]*\.\w{1,10})/gi,
    // Arrow: -> /path  or  → /path
    /(?:->|→)\s*((?:[A-Za-z]:\\|\/|~\/)[^\s"'`,，。、;；\n]+)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // Strip markdown formatting + trailing punctuation/quotes.
      // NOTE: do NOT strip leading `~` — it could be a real home-relative path like ~/Library/...
      let p = match[1]
        .replace(/^[*_`]+/, '')                     // leading markdown chars (no ~)
        .replace(/[*_`~)）\]】}"'。，,;；:：]+$/, ''); // trailing markdown + punctuation (~ here is fine, it's strikethrough closer)
      // Trim trailing dots that aren't part of extension
      p = p.replace(/\.+$/, '');
      if (hasFileExtension(p)) {
        paths.add(p);
      }
    }
  }

  return Array.from(paths);
}

/**
 * Extract file outputs from tool calls.
 *
 * Two semantic modes (see ExtractMode docs):
 *   - 'deliverables' (default): chat cards / snapshots — strict whitelist
 *   - 'file-ops': RightPanel audit — transparent, includes reads/scripts
 *
 * Default 'deliverables' mode is backwards-compatible with the previous
 * single-purpose API: callers that don't pass options keep their behavior
 * (modulo the .md/.txt/.json whitelist additions and basename-dedup removal,
 * both of which fix latent bugs rather than break existing flows).
 *
 * basename dedup was removed entirely. The original assumption ("same
 * basename in one agent turn = same file") was correct in spirit but
 * violated in practice: callers like FilesSection pass the entire
 * conversation's tool calls (cross-turn, cross-day), where same basename
 * across different paths is a legitimate user pattern (e.g. todo skill
 * writing 2026-04-{28,29,30}.md). Path-only dedup is sufficient — mv/cp's
 * source-cleanup logic in parseCopyMoveCommand handles the "two paths
 * same basename, different semantics" case it was guarding against.
 */
export function extractFileOutputs(
  toolCalls: ToolCall[],
  options?: { mode?: ExtractMode; includeReads?: boolean }
): FileOutput[] {
  const mode: ExtractMode = options?.mode ?? 'deliverables';
  // includeReads default depends on mode: file-ops shows reads (audit view),
  // deliverables doesn't (a read is not a "delivered" artifact).
  const includeReads = options?.includeReads ?? (mode === 'file-ops');

  const files: FileOutput[] = [];
  const seen = new Set<string>();

  const addFile = (rawPath: string, operation: FileOutput['operation']) => {
    if (!rawPath) return;
    // Normalize: strip markdown formatting chars + trailing punctuation, unify separators
    let path = rawPath
      .replace(/^[*_`~]+/, '')          // leading markdown: **bold**, _italic_, `code`, ~~strike~~
      .replace(/[*_`~)）\]】}"'。，,;；:：.]+$/, ''); // trailing markdown + punctuation
    path = normalizeSeparators(path.trim());
    if (!path) return;

    // file-ops: filter explicit noise extensions (logs/tmp/bak/cache/lock/pid)
    if (mode === 'file-ops') {
      const ext = (path.split('.').pop() || '').toLowerCase();
      if (NOISE_EXTENSIONS.has(ext)) return;
    }

    // Path-only dedup (basename dedup removed — see function docstring).
    if (seen.has(path)) {
      // Allow write/create to upgrade a previous read entry
      if (operation !== 'read') {
        const existing = files.find((f) => f.path === path);
        if (existing && existing.operation === 'read') {
          existing.operation = operation;
        }
      }
      return;
    }
    seen.add(path);
    files.push({ path, operation });
  };

  for (const tc of toolCalls) {
    if (tc.result === undefined) continue; // Not completed yet
    if (isToolResultError(tc.result)) continue; // Error result

    const input = tc.input as Record<string, unknown>;
    const inputPath = String(input.path || input.file_path || input.filePath || '');

    // 1. Read tools (opt-in)
    if (FILE_READ_TOOLS.includes(tc.name)) {
      if (includeReads && inputPath) {
        addFile(inputPath, 'read');
      }
      continue;
    }

    // 2. Create tools
    if (FILE_CREATE_TOOLS.includes(tc.name)) {
      if (inputPath) addFile(inputPath, 'create');
      continue;
    }

    // 3. Write/edit tools
    if (FILE_WRITE_TOOLS.includes(tc.name)) {
      if (inputPath) addFile(inputPath, 'write');
      continue;
    }

    // 4. generate_image — extract path from result
    if (tc.name === TOOL_NAMES.GENERATE_IMAGE && tc.result) {
      const match = tc.result.match(/(?:图片已保存到|Image saved to): (.+?)(?:\n|$)/);
      if (match) addFile(match[1].trim(), 'create');
      continue;
    }

    // 5. process_image — result regex + fallback to input.output_path
    if (tc.name === TOOL_NAMES.PROCESS_IMAGE && tc.result) {
      const match = tc.result.match(/(?:Image processed successfully|图片处理成功): (.+?)(?:\n|$)/);
      if (match) {
        addFile(match[1].trim(), 'create');
      } else if (input.output_path) {
        addFile(String(input.output_path), 'create');
      }
      continue;
    }

    // 5b. computer screenshot — saved to disk, path announced in result text
    if (tc.name === TOOL_NAMES.COMPUTER && tc.result) {
      const match = tc.result.match(/Screenshot saved to: (.+?)(?:\n|$)/);
      if (match) addFile(match[1].trim(), 'create');
      continue;
    }

    // 6. Command tools — parse stdout + command string for file paths
    if (COMMAND_TOOLS.includes(tc.name)) {
      // Skip failed commands — don't extract paths from cp/mv that got sandbox-blocked
      if (tc.result && isCommandFailed(tc.result)) {
        continue;
      }
      // 6a. Search stdout for announced file paths
      if (tc.result) {
        const stdout = extractStdout(tc.result);
        const textToSearch = stdout || tc.result;
        const foundPaths = extractFilePathsFromText(textToSearch);
        for (const p of foundPaths) addFile(p, 'create');
      }
      // 6b. Extract document paths from command string (skip read-only commands)
      const cmd = String(input.command || input.cmd || '');
      if (cmd && !isReadOnlyCommand(cmd)) {
        // 6b-i. Fast-path for simple mv/cp: the DESTINATION is the meaningful
        // output, not the source. The generic regex extractor would grab both
        // paths and then dedupe by basename (source wins), binding file cards
        // and snapshots to a path that has just been deleted.
        const mv = parseCopyMoveCommand(cmd);
        if (mv) {
          // Wipe any entries (from this or prior tool calls) that point at a
          // source path — they now refer to a file that no longer exists.
          // basename dedup was removed, so we only need to remove entries
          // whose path exactly matches a source (basename-collision is no
          // longer a hazard for unrelated files).
          for (const src of mv.sources) {
            const srcNorm = normalizeSeparators(src);
            for (let i = files.length - 1; i >= 0; i--) {
              if (files[i].path === srcNorm) {
                seen.delete(srcNorm);
                files.splice(i, 1);
              }
            }
          }
          // Map each source to its final destination path. If the destination
          // has no extension, treat it as a directory and join with source
          // basename (the POSIX convention for `mv a b/`).
          const destHasExt = hasFileExtension(mv.destination);
          const destAccepted = (ext: string): boolean => {
            const lower = ext.toLowerCase();
            return mode === 'deliverables'
              ? DOCUMENT_EXTENSIONS.has(lower)
              : !NOISE_EXTENSIONS.has(lower);
          };
          for (const src of mv.sources) {
            const srcBase = getBaseName(normalizeSeparators(src));
            const destPath = destHasExt
              ? mv.destination
              : joinPath(mv.destination, srcBase);
            const destExt = destPath.split('.').pop() || '';
            if (destAccepted(destExt)) {
              addFile(destPath, 'create');
            }
          }
        } else {
          // 6b-ii. Generic path: regex-extract paths from argv per mode.
          const docPaths = extractPathsFromCommand(cmd, mode);
          for (const p of docPaths) addFile(p, 'create');
        }
      }
      continue;
    }

    // 7. delegate_to_agent — search result text for file paths
    if (tc.name === TOOL_NAMES.DELEGATE_TO_AGENT && tc.result) {
      const foundPaths = extractFilePathsFromText(tc.result);
      for (const p of foundPaths) addFile(p, 'create');
      continue;
    }

    // 8. MCP tools (name contains '__') — input path fields + result text
    if (tc.name.includes('__')) {
      // Check input for path-like fields
      for (const key of ['path', 'file_path', 'filePath', 'output_path', 'outputPath', 'destination']) {
        const val = input[key];
        if (typeof val === 'string' && hasFileExtension(val)) {
          addFile(val, 'create');
        }
      }
      // Also search result text
      if (tc.result) {
        const foundPaths = extractFilePathsFromText(tc.result);
        for (const p of foundPaths) addFile(p, 'create');
      }
      continue;
    }
  }

  // ── Filter out intermediate scripts that were executed by run_command ──
  //
  // Only applies in 'deliverables' mode: if a script file (e.g. .py, .js)
  // was written AND then executed, it's an intermediate artifact — the user
  // cares about the output, not the script.
  //
  // 'file-ops' mode skips this filter on purpose: the audit view should
  // surface "the AI ran build.py" so the user can see what scripts were
  // executed, not just the artifacts they produced.
  if (mode === 'deliverables') {
    const executedScripts = new Set<string>();

    const allCommands: string[] = [];
    for (const tc of toolCalls) {
      if (COMMAND_TOOLS.includes(tc.name) && tc.result !== undefined) {
        const cmd = String((tc.input as Record<string, unknown>).command || (tc.input as Record<string, unknown>).cmd || '');
        if (cmd) allCommands.push(cmd);
      }
    }

    for (const f of files) {
      const ext = f.path.split('.').pop()?.toLowerCase() || '';
      if (!SCRIPT_EXTENSIONS.has(ext)) continue;

      const fileName = f.path.split('/').pop() || f.path.split('\\').pop() || '';

      for (const cmd of allCommands) {
        if (cmd.includes(f.path) || (fileName && cmd.includes(fileName))) {
          executedScripts.add(f.path);
          break;
        }
      }
    }

    return files.filter((f) => !executedScripts.has(f.path));
  }

  return files;
}
