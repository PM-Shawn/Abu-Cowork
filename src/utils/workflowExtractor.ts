import type { ToolCall, AgentStatus } from '@/types';

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
const FILE_READ_TOOLS = ['read_file', 'read', 'get_file_contents'];
const FILE_WRITE_TOOLS = ['write_file', 'edit_file', 'write', 'edit'];
const FILE_CREATE_TOOLS = ['create_file', 'create'];
const COMMAND_TOOLS = ['run_command', 'bash', 'execute', 'shell'];
const SKILL_TOOLS = ['use_skill'];

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
    case 'read_file':
    case 'read':
    case 'get_file_contents':
      return {
        label: fileName ? `读取 ${fileName}` : '读取文件',
        detail: path,
      };
    case 'write_file':
    case 'write':
      return {
        label: fileName ? `写入 ${fileName}` : '写入文件',
        detail: path,
      };
    case 'edit_file':
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
    case 'run_command':
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
    case 'use_skill': {
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
      status: 'completed',
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
    if (tc.name === 'use_skill') {
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
    case 'list_directory': {
      const count = parseFileCount(result);
      return isZh
        ? `成功列出 ${count} 个文件和文件夹`
        : `Listed ${count} files and folders`;
    }

    case 'read_file':
    case 'read':
    case 'get_file_contents':
      if (!isSuccess) {
        return isZh ? `读取失败` : `Failed to read`;
      }
      return isZh
        ? `成功读取 ${fileName || '文件'}`
        : `Read ${fileName || 'file'} successfully`;

    case 'write_file':
    case 'write':
      if (!isSuccess) {
        return isZh ? `写入失败` : `Failed to write`;
      }
      return isZh
        ? `成功写入 ${fileName || '文件'}`
        : `Wrote to ${fileName || 'file'} successfully`;

    case 'edit_file':
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

    case 'run_command':
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

    case 'get_system_info':
      return isZh ? `获取系统信息成功` : `Got system info`;

    case 'search':
    case 'grep':
    case 'find': {
      const matchCount = result.split('\n').filter((l) => l.trim()).length;
      return isZh
        ? `搜索完成，找到 ${matchCount} 条结果`
        : `Search complete, found ${matchCount} results`;
    }

    case 'manage_scheduled_task': {
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

/** Document extensions that are likely final user-facing outputs */
const DOCUMENT_EXTENSIONS = new Set([
  'pptx', 'ppt', 'docx', 'doc', 'pdf', 'xlsx', 'xls', 'csv',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'html', 'htm',
]);

/** Extract document file paths from a shell command string */
function extractDocumentPathsFromCommand(cmd: string): string[] {
  const paths: string[] = [];
  // Match quoted paths
  const quotedRegex = /["']((?:\/|~\/)[^"'\n]+\.(\w{1,10}))["']/g;
  let match: RegExpExecArray | null;
  while ((match = quotedRegex.exec(cmd)) !== null) {
    if (DOCUMENT_EXTENSIONS.has(match[2].toLowerCase())) paths.push(match[1]);
  }
  // Match unquoted absolute paths
  if (paths.length === 0) {
    const unquotedRegex = /(?:^|\s)((?:\/|~\/)\S+\.(\w{1,10}))(?:\s|$)/g;
    while ((match = unquotedRegex.exec(cmd)) !== null) {
      if (DOCUMENT_EXTENSIONS.has(match[2].toLowerCase())) paths.push(match[1]);
    }
  }
  return paths;
}

/**
 * Extract file paths from text output (stdout, delegate results, etc.)
 * Matches common Chinese/English patterns for file output announcements.
 */
export function extractFilePathsFromText(text: string): string[] {
  const paths = new Set<string>();

  // Pattern groups for file output announcements
  // Optional leading quote/bracket is consumed but not captured
  const patterns: RegExp[] = [
    // Chinese: 已保存到 /path/to/file.ext
    /(?:已保存到|输出到|写入到|生成到|导出到|已创建|生成完成)\s*[:：]?\s*['"`]?((?:[A-Za-z]:\\|\/)[^\s"'`,，。、;；\n]+)/g,
    // English: saved to /path/to/file.ext
    /(?:saved to|output to|written to|exported to|generated at|created at|created)\s*[:：]?\s*['"`]?((?:[A-Za-z]:\\|\/)[^\s"'`,，。、;；\n]+)/gi,
    // Label: Output file: /path  or  输出文件: /path  or  文件位置: /path
    /(?:Output file|输出文件|文件位置|文件路径|保存在|保存到)\s*[:：]\s*['"`]?((?:[A-Za-z]:\\|\/|[^\s"'`,，。、;；\n/\\])[^\s"'`,，。、;；\n]*\.\w{1,10})/gi,
    // Arrow: -> /path  or  → /path
    /(?:->|→)\s*['"`]?((?:[A-Za-z]:\\|\/)[^\s"'`,，。、;；\n]+)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // Strip trailing punctuation/quotes
      let p = match[1].replace(/[)）\]】}"'`。，,;；:：]+$/, '');
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
 * Extract file outputs from tool calls for attachment display
 */
export function extractFileOutputs(
  toolCalls: ToolCall[],
  options?: { includeReads?: boolean }
): FileOutput[] {
  const files: FileOutput[] = [];
  const seen = new Set<string>();
  const includeReads = options?.includeReads ?? false;

  const addFile = (path: string, operation: FileOutput['operation']) => {
    if (!path) return;
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
    if (tc.name === 'generate_image' && tc.result) {
      const match = tc.result.match(/(?:图片已保存到|Image saved to): (.+?)(?:\n|$)/);
      if (match) addFile(match[1].trim(), 'create');
      continue;
    }

    // 5. process_image — result regex + fallback to input.output_path
    if (tc.name === 'process_image' && tc.result) {
      const match = tc.result.match(/(?:Image processed successfully|图片处理成功): (.+?)(?:\n|$)/);
      if (match) {
        addFile(match[1].trim(), 'create');
      } else if (input.output_path) {
        addFile(String(input.output_path), 'create');
      }
      continue;
    }

    // 6. Command tools — parse stdout + command string for file paths
    if (COMMAND_TOOLS.includes(tc.name)) {
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
        const docPaths = extractDocumentPathsFromCommand(cmd);
        for (const p of docPaths) addFile(p, 'create');
      }
      continue;
    }

    // 7. delegate_to_agent — search result text for file paths
    if (tc.name === 'delegate_to_agent' && tc.result) {
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
  // If a script file (e.g. .py, .js) was written AND then executed, it's an intermediate
  // artifact — the user cares about the output file, not the script itself.
  const executedScripts = new Set<string>();

  // Collect all commands for matching
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

    // Extract just the filename for flexible matching
    // e.g. "/Users/didi/Desktop/PPT/build_ppt.js" → "build_ppt.js"
    const fileName = f.path.split('/').pop() || f.path.split('\\').pop() || '';

    for (const cmd of allCommands) {
      // Match either full path or just filename in the command
      // Handles: "node /full/path/build.js", "cd /dir && node build.js", "python3 build.py"
      if (cmd.includes(f.path) || (fileName && cmd.includes(fileName))) {
        executedScripts.add(f.path);
        break;
      }
    }
  }

  return files.filter((f) => !executedScripts.has(f.path));
}
