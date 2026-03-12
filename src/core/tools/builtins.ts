import { readTextFile, writeTextFile, writeFile as writeBinFile, readDir, exists } from '@tauri-apps/plugin-fs';
import { homeDir, desktopDir, documentDir, downloadDir } from '@tauri-apps/api/path';
import { readText as clipboardReadText, writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { useDiscoveryStore } from '../../stores/discoveryStore';
import { platform } from '@tauri-apps/plugin-os';
import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition, ToolResult, ToolResultContent, Conversation } from '../../types';
import { toolRegistry } from './registry';
import { skillLoader } from '../skill/loader';
import { initPlatform, isWindows } from '../../utils/platform';
import { extractUsername, joinPath, ensureParentDir, getParentDir } from '../../utils/pathUtils';
import { getTauriFetch } from '../llm/tauriFetch';
import { agentRegistry } from '../agent/registry';
import { getCurrentLoopContext, requestWorkspace } from '../agent/agentLoop';
import { runSubagentLoop, extractParentConversationSummary } from '../agent/subagentLoop';
import type { SubagentProgressEvent } from '../agent/subagentLoop';
import { createSubagentController } from '../agent/subagentAbort';
import { appendAgentMemory, saveAgentMemory, clearAgentMemory, saveProjectMemory, appendProjectMemory, clearProjectMemory } from '../agent/agentMemory';
import { appendTaskLog, type TaskCategory } from '../agent/taskLog';
import { searchMCPRegistry, installMCPServer, getRegistryEntry } from '../agent/mcpDiscovery';
import { addWatchRule, removeWatchRule, toggleWatchRule, listWatchRules, type FileWatchRule } from '../agent/fileWatcher';
import { getTodos, addTodo, updateTodo, setTodos, formatTodosForPrompt } from '../agent/todoManager';
import type { TodoStatus } from '../agent/todoManager';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { isSandboxEnabled, isNetworkIsolationEnabled } from '../sandbox/config';
import { useScheduleStore } from '../../stores/scheduleStore';
import type { ScheduleConfig, ScheduleFrequency } from '../../types/schedule';
// Path safety checks are now handled centrally in registry.ts executeAnyTool

interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

// Cache system info to avoid repeated async calls
let cachedSystemInfo: Record<string, string> | null = null;

async function getSystemInfoData(): Promise<Record<string, string>> {
  if (cachedSystemInfo) return cachedSystemInfo;

  const [currentPlatform, home, desktop, documents, downloads] = await Promise.all([
    platform(),
    homeDir(),
    desktopDir(),
    documentDir(),
    downloadDir(),
  ]);

  // Initialize platform singleton for synchronous isWindows() checks
  await initPlatform();

  cachedSystemInfo = {
    platform: currentPlatform,
    home,
    desktop,
    documents,
    downloads,
    username: extractUsername(home),
  };

  return cachedSystemInfo;
}

const getSystemInfoTool: ToolDefinition = {
  name: 'get_system_info',
  description: 'Get system environment information including home directory, desktop path, documents path, etc. Use this FIRST when you need to know where files are located on the user\'s computer.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async () => {
    try {
      const info = await getSystemInfoData();
      return `System Information:
- Platform: ${info.platform}
- Username: ${info.username}
- Home Directory: ${info.home}
- Desktop: ${info.desktop}
- Documents: ${info.documents}
- Downloads: ${info.downloads}`;
    } catch (err) {
      return `Error getting system info: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file at the given path. Returns the file content as text.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to read' },
    },
    required: ['path'],
  },
  execute: async (input) => {
    const filePath = input.path as string;

    try {
      // PDF files: extract text instead of returning raw binary
      if (filePath.toLowerCase().endsWith('.pdf')) {
        // Strategy 1: pdftotext (macOS/Linux — fast, native)
        if (!isWindows()) {
          try {
            const output = await invoke<CommandOutput>('run_shell_command', {
              command: `pdftotext "${filePath}" -`,
              cwd: null,
              background: false,
              timeout: 30,
            });
            if (output.code === 0 && output.stdout.trim()) {
              return output.stdout;
            }
          } catch { /* fall through to Python */ }
        }

        // Strategy 2: Python pdfplumber (cross-platform)
        try {
          const pyBin = isWindows() ? 'python' : 'python3';
          const escapedPath = isWindows()
            ? filePath.replace(/'/g, "''")
            : filePath.replace(/'/g, "'\\''");
          const pyCmd = `${pyBin} -c "import pdfplumber; pdf=pdfplumber.open('${escapedPath}'); print('\\n'.join(p.extract_text() or '' for p in pdf.pages)); pdf.close()"`;
          const output = await invoke<CommandOutput>('run_shell_command', {
            command: pyCmd,
            cwd: null,
            background: false,
            timeout: 30,
          });
          if (output.code === 0 && output.stdout.trim()) {
            return output.stdout;
          }
        } catch { /* fall through to hint */ }

        // Strategy 3: User hint
        return isWindows()
          ? 'Error: Cannot read PDF as text. Please install Python and run: pip install pdfplumber'
          : 'Error: Cannot read PDF as text. Install pdftotext (brew install poppler) or: pip3 install pdfplumber';
      }

      const content = await readTextFile(filePath);
      return content;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file at the given path. Creates the file if it does not exist, overwrites if it does.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to write' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['path', 'content'],
  },
  execute: async (input) => {
    const path = input.path as string;
    const content = input.content as string;

    // Guard: reject binary formats with helpful error message
    const binaryExts = ['.docx', '.xlsx', '.pptx', '.zip', '.pdf', '.png', '.jpg', '.gif'];
    const ext = path.toLowerCase().slice(path.lastIndexOf('.'));
    if (binaryExts.includes(ext)) {
      return `Error: write_file only writes plain text. Cannot create ${ext} files directly. ` +
        `Use run_command to execute a script that generates the binary file programmatically.`;
    }

    try {
      await ensureParentDir(path);
      // Add UTF-8 BOM for CSV files so Excel opens them with correct encoding
      let finalContent = content;
      if (ext === '.csv' && !content.startsWith('\uFEFF')) {
        finalContent = '\uFEFF' + content;
      }
      await writeTextFile(path, finalContent);
      return `Successfully wrote ${content.length} characters to ${path}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description: 'List the contents of a directory. Returns file and directory names with their types, sorted alphabetically.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the directory to list' },
    },
    required: ['path'],
  },
  execute: async (input) => {
    const dirPath = input.path as string;

    try {
      const entries = await readDir(dirPath);
      if (entries.length === 0) {
        return `Directory "${dirPath}" is empty.`;
      }

      // Sort alphabetically (case-insensitive)
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      const lines = entries.map((entry) => {
        const type = entry.isDirectory ? '[DIR]' : '[FILE]';
        return `${type} ${entry.name}`;
      });
      return lines.join('\n');
    } catch (err) {
      return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description: 'Execute a shell command on the user\'s computer and return the output. Use this for tasks that require running programs, scripts, or system commands. For long-running services (like web servers), set background=true to start in background mode and get initial output.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Working directory for the command (optional, defaults to user home)' },
      background: { type: 'boolean', description: 'Set to true for long-running services (servers, etc). Will start the process and return initial output after a few seconds.' },
      timeout: { type: 'number', description: 'Timeout in seconds (default 30, max 300). Command will be killed if it exceeds this.' },
    },
    required: ['command'],
  },
  execute: async (input) => {
    const command = input.command as string;
    const cwd = input.cwd as string | undefined;
    const background = input.background as boolean | undefined;
    const timeout = input.timeout as number | undefined;

    try {
      // Exempt `open` commands from sandbox — they use LaunchServices
      // which requires XPC operations blocked by Seatbelt
      const isOpenCmd = /^\s*open\s/.test(command);
      const sandbox = isOpenCmd ? false : isSandboxEnabled();

      // Use custom Tauri command defined in Rust
      const output = await invoke<CommandOutput>('run_shell_command', {
        command,
        cwd: cwd || null,
        background: background || false,
        timeout: Math.min(Math.max(1, timeout ?? 30), 300),
        sandboxEnabled: sandbox,
        networkIsolation: isNetworkIsolationEnabled(),
        extraWritablePaths: [],
      });

      const parts: string[] = [];
      if (output.stdout.trim()) {
        parts.push(`stdout:\n${output.stdout.trim()}`);
      }
      if (output.stderr.trim()) {
        parts.push(`stderr:\n${output.stderr.trim()}`);
      }
      parts.push(`exit code: ${output.code}`);

      return parts.join('\n\n');
    } catch (err) {
      return `Error executing command: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * edit_file tool — find and replace a substring in a file
 */
const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Edit a file by replacing a specific text substring with new text. The old_content must be an exact match of the text in the file. Use this instead of write_file when you only need to change part of a file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to edit' },
      old_content: { type: 'string', description: 'The exact text to find and replace (must match exactly, including whitespace and indentation)' },
      new_content: { type: 'string', description: 'The new text to replace old_content with' },
    },
    required: ['path', 'old_content', 'new_content'],
  },
  execute: async (input) => {
    const path = input.path as string;
    const oldContent = input.old_content as string;
    const newContent = input.new_content as string;

    try {
      // Check file exists
      if (!(await exists(path))) {
        return `Error: File not found: ${path}`;
      }

      const content = await readTextFile(path);

      // Count occurrences
      const occurrences = content.split(oldContent).length - 1;

      if (occurrences === 0) {
        // Find most similar line to help the user
        const oldLines = oldContent.split('\n');
        const fileLines = content.split('\n');
        let bestMatch = '';
        let bestScore = 0;

        for (const fileLine of fileLines) {
          for (const oldLine of oldLines) {
            if (!oldLine.trim()) continue;
            const score = similarityScore(fileLine.trim(), oldLine.trim());
            if (score > bestScore) {
              bestScore = score;
              bestMatch = fileLine;
            }
          }
        }

        let hint = '';
        if (bestScore > 0.5) {
          hint = `\nMost similar line found:\n"${bestMatch.trim()}"`;
        }
        return `Error: old_content not found in file. Make sure it matches exactly, including whitespace and indentation.${hint}`;
      }

      if (occurrences > 1) {
        return `Error: old_content matches ${occurrences} locations. Please provide more surrounding context to make the match unique.`;
      }

      // Perform replacement
      const updated = content.replace(oldContent, newContent);
      await writeTextFile(path, updated);

      const oldLines = oldContent.split('\n').length;
      const newLines = newContent.split('\n').length;
      return `Successfully edited ${path}: replaced ${oldLines} line(s) with ${newLines} line(s)`;
    } catch (err) {
      return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** Simple similarity score (0-1) based on common characters */
function similarityScore(a: string, b: string): number {
  if (!a || !b) return 0;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1.0;
  const matchCount = shorter.split('').filter((ch, i) => longer[i] === ch).length;
  return matchCount / longer.length;
}

/**
 * search_files tool — grep-like search across files
 */
const searchFilesTool: ToolDefinition = {
  name: 'search_files',
  description: 'Search for a text pattern across files in a directory (like grep). Returns matching lines with file paths and line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The text or regex pattern to search for' },
      path: { type: 'string', description: 'Directory to search in (absolute path)' },
      include: { type: 'string', description: 'File glob pattern to include (e.g., "*.ts", "*.py")' },
      max_results: { type: 'number', description: 'Maximum number of matching lines to return (default 50)' },
    },
    required: ['pattern', 'path'],
  },
  execute: async (input) => {
    const pattern = input.pattern as string;
    const searchPath = input.path as string;
    const include = input.include as string | undefined;
    const safeMaxResults = Math.min(Math.max(1, Math.floor(Number(input.max_results) || 50)), 500);

    // Sanitize inputs to prevent injection (strip newlines then escape quotes)
    const safePattern = pattern.replace(/[\n\r]/g, ' ').replace(/'/g, "'\\''");
    const safePath = searchPath.replace(/[\n\r]/g, ' ').replace(/'/g, "'\\''");

    let command: string;
    if (isWindows()) {
      // Windows: use PowerShell for recursive grep-like search
      const psPattern = pattern.replace(/[\n\r]/g, ' ').replace(/'/g, "''");
      const psPath = searchPath.replace(/[\n\r]/g, ' ').replace(/'/g, "''");
      const includeFilter = include
        ? ` -Include '${include.replace(/'/g, "''")}'`
        : '';
      command = `Get-ChildItem -Path '${psPath}' -Recurse -File${includeFilter} | Select-String -Pattern '${psPattern}' | Select-Object -First ${safeMaxResults}`;
    } else {
      command = `grep -rn --color=never '${safePattern}' '${safePath}'`;
      if (include) {
        const safeInclude = include.replace(/[\n\r]/g, ' ').replace(/'/g, "'\\''");
        command = `grep -rn --color=never --include='${safeInclude}' '${safePattern}' '${safePath}'`;
      }
      command += ` | head -n ${safeMaxResults}`;
    }

    try {
      const output = await invoke<CommandOutput>('run_shell_command', {
        command,
        cwd: null,
        background: false,
        timeout: 15,
        sandboxEnabled: isSandboxEnabled(),
        networkIsolation: isNetworkIsolationEnabled(),
        extraWritablePaths: [],
      });

      if (output.stdout.trim()) {
        const cleaned = output.stdout.replace(/\r\n/g, '\n').trim();
        const lines = cleaned.split('\n');
        return `Found ${lines.length}${lines.length >= safeMaxResults ? '+' : ''} matches:\n${cleaned}`;
      }
      if (output.code === 1) {
        return 'No matches found.';
      }
      if (output.stderr.trim()) {
        return `Error: ${output.stderr.trim()}`;
      }
      return 'No matches found.';
    } catch (err) {
      return `Error searching files: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * find_files tool — find files by name pattern
 */
const findFilesTool: ToolDefinition = {
  name: 'find_files',
  description: 'Find files by name pattern in a directory (like the find command). Returns matching file paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'File name pattern to search for (glob, e.g., "*.ts", "*.py", "README*")' },
      path: { type: 'string', description: 'Directory to search in (absolute path)' },
      max_results: { type: 'number', description: 'Maximum number of results to return (default 100)' },
    },
    required: ['pattern', 'path'],
  },
  execute: async (input) => {
    const pattern = input.pattern as string;
    const searchPath = input.path as string;
    const safeMaxResults = Math.min(Math.max(1, Math.floor(Number(input.max_results) || 100)), 500);

    // Sanitize inputs (strip newlines then escape quotes)
    const safePattern = pattern.replace(/[\n\r]/g, ' ').replace(/'/g, "'\\''");
    const safePath = searchPath.replace(/[\n\r]/g, ' ').replace(/'/g, "'\\''");

    let command: string;
    if (isWindows()) {
      // Windows: use PowerShell for recursive file find
      const psPattern = pattern.replace(/[\n\r]/g, ' ').replace(/'/g, "''");
      const psPath = searchPath.replace(/[\n\r]/g, ' ').replace(/'/g, "''");
      command = `Get-ChildItem -Path '${psPath}' -Recurse -Name -Include '${psPattern}' | Where-Object { $_ -notlike '*\\node_modules\\*' -and $_ -notlike '*\\.git\\*' } | Select-Object -First ${safeMaxResults}`;
    } else {
      command = `find '${safePath}' -name '${safePattern}' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -n ${safeMaxResults}`;
    }

    try {
      const output = await invoke<CommandOutput>('run_shell_command', {
        command,
        cwd: null,
        background: false,
        timeout: 15,
        sandboxEnabled: isSandboxEnabled(),
        networkIsolation: isNetworkIsolationEnabled(),
        extraWritablePaths: [],
      });

      if (output.stdout.trim()) {
        const cleaned = output.stdout.replace(/\r\n/g, '\n').trim();
        const lines = cleaned.split('\n');
        return `Found ${lines.length}${lines.length >= safeMaxResults ? '+' : ''} files:\n${cleaned}`;
      }
      return 'No files found matching the pattern.';
    } catch (err) {
      return `Error finding files: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// Module-level map to track skill hook cleanup functions.
// Exported for cleanup on conversation delete/switch.
const skillHookCleanups = new Map<string, () => void>();

/** Clear all active skill hooks (called on conversation delete/switch) */
export function clearAllSkillHooks(): void {
  for (const cleanup of skillHookCleanups.values()) {
    cleanup();
  }
  skillHookCleanups.clear();
}

/**
 * use_skill tool - allows Claude to load and use a skill when it determines it's relevant
 * This mimics Claude Code's behavior where Claude decides when to use skills
 */
const useSkillTool: ToolDefinition = {
  name: 'use_skill',
  description: 'Load a skill to help with the current task. The skill instructions will be injected into your system prompt for this turn only (auto-deactivates when the loop ends). Returns a brief confirmation.',
  inputSchema: {
    type: 'object',
    properties: {
      skill_name: {
        type: 'string',
        description: 'The name of the skill to use (e.g., "explain-code", "write-tests")'
      },
      context: {
        type: 'string',
        description: 'Additional context or arguments to pass to the skill'
      },
    },
    required: ['skill_name'],
  },
  execute: async (input) => {
    const skillName = input.skill_name as string;
    const context = input.context as string | undefined;

    const skill = skillLoader.getSkill(skillName);
    if (!skill) {
      const available = skillLoader.getAvailableSkills().map(s => s.name).join(', ');
      return `Error: Skill "${skillName}" not found. Available skills: ${available}`;
    }

    // Store the skill activation and arguments — the agentLoop will pick this up
    // and inject it into the system prompt via orchestrator

    const state = useChatStore.getState();
    const activeId = state.activeConversationId;
    if (activeId) {
      useChatStore.setState((draft: { conversations: Record<string, Conversation> }) => {
        const conv = draft.conversations[activeId];
        if (conv) {
          if (!conv.activeSkills) conv.activeSkills = [];
          if (!conv.activeSkills.includes(skillName)) {
            conv.activeSkills.push(skillName);
          }
          // Store arguments for variable substitution
          if (context) {
            if (!conv.activeSkillArgs) conv.activeSkillArgs = {};
            conv.activeSkillArgs[skillName] = context;
          }
        }
      });
    }

    // Activate skill-scoped hooks
    if (skill.hooks) {
      const { activateSkillHooks } = await import('../skill/skillHooks');
      const cleanup = activateSkillHooks(skill);
      // Store cleanup on the module-level map for deactivation
      skillHookCleanups.set(skillName, cleanup);
    }

    // Also load chain skills if defined
    if (skill.chain) {
      for (const chainedName of skill.chain) {
        const chainedSkill = skillLoader.getSkill(chainedName);
        if (chainedSkill && activeId) {
          useChatStore.setState((draft: { conversations: Record<string, Conversation> }) => {
            const conv = draft.conversations[activeId];
            if (conv) {
              if (!conv.activeSkills) conv.activeSkills = [];
              if (!conv.activeSkills.includes(chainedName)) {
                conv.activeSkills.push(chainedName);
              }
            }
          });
        }
      }
    }

    let result = `已加载技能 "${skill.name}": ${skill.description}`;
    if (context) {
      result += `\n用户上下文: ${context}`;
    }
    result += '\n技能指令已注入本轮系统提示，任务结束后自动释放。';
    return result;
  },
};


/**
 * report_plan tool - AI reports task steps in user-friendly terms
 * These are high-level business steps, not technical tool calls
 */
const reportPlanTool: ToolDefinition = {
  name: 'report_plan',
  description: '上报任务执行计划。在开始执行任何任务前必须先调用此工具，告知用户你将要执行的步骤。步骤描述要用用户能理解的业务语言，不要提及工具名称。',
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: '任务步骤数组，用用户能理解的语言描述。例如：["扫描桌面文件", "识别发票", "创建发票文件夹", "移动发票到文件夹"]'
      },
    },
    required: ['steps'],
  },
  execute: async (input) => {
    const steps = input.steps as string[];
    if (!steps || steps.length === 0) {
      return '已记录执行计划';
    }
    return `已记录执行计划：${steps.length}个步骤`;
  },
};

/**
 * generate_image tool — generate images via DALL-E 3 API
 */
const generateImageTool: ToolDefinition = {
  name: 'generate_image',
  description: 'Generate an image from a text prompt using DALL-E 3. Returns the local file path of the saved image.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Text description of the image to generate' },
      size: { type: 'string', description: 'Image size: 1024x1024, 1792x1024, or 1024x1792 (default: 1024x1024)' },
      style: { type: 'string', description: 'Image style: vivid or natural (default: vivid)' },
      save_path: { type: 'string', description: 'Optional absolute path to save the image. If not provided, saves to Downloads folder.' },
    },
    required: ['prompt'],
  },
  execute: async (input) => {
    const prompt = input.prompt as string;
    const size = (input.size as string) || '1024x1024';
    const style = (input.style as string) || 'vivid';
    const savePath = input.save_path as string | undefined;

    try {

      const state = useSettingsStore.getState();

      // Resolve API key: imageGenApiKey > OpenAI provider key
      let apiKey = state.imageGenApiKey;
      if (!apiKey && state.provider === 'openai') {
        apiKey = state.apiKey;
      }
      if (!apiKey) {
        return 'Error: No API key configured for image generation. Please set an OpenAI API key in Settings → Image Generation, or configure an OpenAI provider.';
      }

      const model = state.imageGenModel || 'dall-e-3';

      // Resolve base URL: imageGenBaseUrl > default OpenAI
      const baseUrl = (state.imageGenBaseUrl || 'https://api.openai.com').replace(/\/+$/, '');

      // Call image generation API via Tauri fetch (bypasses CORS)
      const fetchFn = await getTauriFetch();

      // Build request body — only include params the model supports
      const reqBody: Record<string, unknown> = {
        model,
        prompt,
        n: 1,
        size,
        response_format: 'b64_json',
      };
      // DALL-E 3 supports style, other models may not
      if (model.startsWith('dall-e-3')) {
        reqBody.style = style;
      }

      const response = await fetchFn(`${baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return `Error generating image: ${response.status} ${errorText}`;
      }

      const result = await response.json() as {
        data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
      };

      // Decode image data — prefer b64_json, fallback to URL download
      let bytes: Uint8Array;
      const b64Data = result.data?.[0]?.b64_json;
      if (b64Data) {
        const resp = await fetch(`data:image/png;base64,${b64Data}`);
        bytes = new Uint8Array(await resp.arrayBuffer());
      } else {
        const imageUrl = result.data?.[0]?.url;
        if (!imageUrl) {
          return 'Error: API 未返回图片数据';
        }
        const imageResponse = await fetchFn(imageUrl);
        if (!imageResponse.ok) {
          return `Error downloading image: ${imageResponse.status}`;
        }
        bytes = new Uint8Array(await imageResponse.arrayBuffer());
      }

      // Determine save path: explicit > workspace > downloads
      let finalPath = savePath;
      if (!finalPath) {
        const workspacePath = useWorkspaceStore.getState().currentPath;
        const baseDir = workspacePath || await downloadDir();
        const timestamp = Date.now();
        finalPath = joinPath(baseDir, `abu-image-${timestamp}.png`);
      }

      await ensureParentDir(finalPath);
      await writeBinFile(finalPath, bytes);

      const revisedPrompt = result.data?.[0]?.revised_prompt;
      let msg = `图片已保存到: ${finalPath}`;
      if (revisedPrompt) {
        msg += `\n优化后的提示词: ${revisedPrompt}`;
      }
      return msg;
    } catch (err) {
      return `Error generating image: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * process_image tool — image processing using system tools
 */
const processImageTool: ToolDefinition = {
  name: 'process_image',
  description: 'Process an image file: resize, crop, convert format, or compress. Uses system tools (sips on macOS, PowerShell on Windows).',
  inputSchema: {
    type: 'object',
    properties: {
      input_path: { type: 'string', description: 'Absolute path to the input image file' },
      output_path: { type: 'string', description: 'Absolute path for the output image file' },
      action: { type: 'string', description: 'Action to perform: resize, crop, convert, or compress', enum: ['resize', 'crop', 'convert', 'compress'] },
      width: { type: 'number', description: 'Target width in pixels (for resize and crop)' },
      height: { type: 'number', description: 'Target height in pixels (for resize and crop)' },
      x: { type: 'number', description: 'X offset for crop (default 0)' },
      y: { type: 'number', description: 'Y offset for crop (default 0)' },
      format: { type: 'string', description: 'Target format for convert (png, jpeg, gif, bmp, tiff)' },
      quality: { type: 'number', description: 'Quality 1-100 for compress (default 80)' },
    },
    required: ['input_path', 'output_path', 'action'],
  },
  execute: async (input) => {
    const inputPath = input.input_path as string;
    const outputPath = input.output_path as string;
    const action = input.action as string;
    // Merge top-level params with nested params object (top-level takes priority)
    const nested = (input.params as Record<string, unknown>) || {};
    const params: Record<string, unknown> = {
      ...nested,
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      ...(input.x !== undefined ? { x: input.x } : {}),
      ...(input.y !== undefined ? { y: input.y } : {}),
      ...(input.format !== undefined ? { format: input.format } : {}),
      ...(input.quality !== undefined ? { quality: input.quality } : {}),
    };

    try {
      const validActions = processImageTool.inputSchema.properties.action.enum!;
      if (!validActions.includes(action)) {
        return `Error: Unsupported action "${action}". Use one of: ${validActions.join(', ')}`;
      }

      await ensureParentDir(outputPath);

      let command: string;

      if (isWindows()) {
        // Windows: use PowerShell + System.Drawing
        command = buildWindowsImageCommand(inputPath, outputPath, action, params);
      } else {
        // macOS/Linux: use sips (macOS built-in)
        command = buildMacImageCommand(inputPath, outputPath, action, params);
      }

      console.log('[process_image] command:', command);

      // outputPath's parent directory needs write access in sandbox
      const outputDir = getParentDir(outputPath);
      const output = await invoke<CommandOutput>('run_shell_command', {
        command,
        cwd: null,
        background: false,
        timeout: 30,
        sandboxEnabled: isSandboxEnabled(),
        networkIsolation: isNetworkIsolationEnabled(),
        extraWritablePaths: outputDir ? [outputDir] : [],
      });

      console.log('[process_image] exit code:', output.code, 'stdout:', output.stdout, 'stderr:', output.stderr);

      if (output.code !== 0) {
        return `Error processing image: ${output.stderr || output.stdout}`;
      }

      return `Image processed successfully: ${outputPath}`;
    } catch (err) {
      return `Error processing image: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const ALLOWED_IMAGE_FORMATS = ['png', 'jpeg', 'jpg', 'gif', 'bmp', 'tiff'];

function buildMacImageCommand(
  inputPath: string, outputPath: string, action: string, params: Record<string, unknown>
): string {
  // Escape paths for shell
  const safein = inputPath.replace(/'/g, "'\\''");
  const safeout = outputPath.replace(/'/g, "'\\''");

  // First copy input to output, then modify in-place with sips
  const copy = `cp '${safein}' '${safeout}'`;

  switch (action) {
    case 'resize': {
      const w = Number(params.width) || 800;
      const h = Number(params.height) || 600;
      // sips -z resizes to exact height×width without maintaining aspect ratio
      return `${copy} && sips -z ${h} ${w} '${safeout}'`;
    }
    case 'crop': {
      const cw = Number(params.width) || 800;
      const ch = Number(params.height) || 600;
      return `${copy} && sips --cropToHeightWidth ${ch} ${cw} '${safeout}'`;
    }
    case 'convert': {
      const format = ((params.format as string) || 'png').toLowerCase();
      if (!ALLOWED_IMAGE_FORMATS.includes(format)) {
        return `echo 'Unsupported format: use one of ${ALLOWED_IMAGE_FORMATS.join(', ')}'`;
      }
      return `${copy} && sips -s format ${format} '${safeout}' --out '${safeout}'`;
    }
    case 'compress': {
      const quality = Math.max(1, Math.min(100, Number(params.quality) || 80));
      return `${copy} && sips -s format jpeg -s formatOptions ${quality} '${safeout}' --out '${safeout}'`;
    }
    default:
      return `echo 'Unsupported action'`;
  }
}

function buildWindowsImageCommand(
  inputPath: string, outputPath: string, action: string, params: Record<string, unknown>
): string {
  const psIn = inputPath.replace(/'/g, "''");
  const psOut = outputPath.replace(/'/g, "''");

  switch (action) {
    case 'resize': {
      const w = Number(params.width) || 800;
      const h = Number(params.height) || 600;
      return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${psIn}'); $bmp = New-Object System.Drawing.Bitmap(${w}, ${h}); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $g.DrawImage($img, 0, 0, ${w}, ${h}); $bmp.Save('${psOut}'); $g.Dispose(); $bmp.Dispose(); $img.Dispose()"`;
    }
    case 'crop': {
      const x = Number(params.x) || 0;
      const y = Number(params.y) || 0;
      const cw = Number(params.width) || 800;
      const ch = Number(params.height) || 600;
      return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${psIn}'); $rect = New-Object System.Drawing.Rectangle(${x}, ${y}, ${cw}, ${ch}); $bmp = ([System.Drawing.Bitmap]$img).Clone($rect, $img.PixelFormat); $bmp.Save('${psOut}'); $bmp.Dispose(); $img.Dispose()"`;
    }
    case 'convert': {
      const format = ((params.format as string) || 'png').toLowerCase();
      const formatMap: Record<string, string> = { png: 'Png', jpg: 'Jpeg', jpeg: 'Jpeg', bmp: 'Bmp', gif: 'Gif' };
      const dotNetFormat = formatMap[format];
      if (!dotNetFormat) {
        return `echo Unsupported format: use one of ${Object.keys(formatMap).join(', ')}`;
      }
      return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${psIn}'); $img.Save('${psOut}', [System.Drawing.Imaging.ImageFormat]::${dotNetFormat}); $img.Dispose()"`;
    }
    case 'compress': {
      const quality = Math.max(1, Math.min(100, Number(params.quality) || 80));
      return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${psIn}'); $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }; $ep = New-Object System.Drawing.Imaging.EncoderParameters(1); $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, ${quality}L); $img.Save('${psOut}', $codec, $ep); $img.Dispose()"`;
    }
    default:
      return `echo Unsupported action`;
  }
}

/**
 * web_search tool — search the web using configured search provider
 */
const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web for information. Returns search results with titles, URLs, and snippets. Use this when: (1) you encounter unfamiliar terms, proper nouns, or product names, (2) the user asks to research/investigate a topic, (3) you need current information. IMPORTANT: Keep proper nouns in original form (e.g. "OpenClaw" not "开放爪子"), prefer searching over guessing.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      count: { type: 'number', description: 'Number of results to return (default 8, max 20)' },
      market: { type: 'string', description: 'Market/locale for results (default: zh-CN)' },
      freshness: { type: 'string', description: 'Freshness filter: Day, Week, Month (optional)' },
    },
    required: ['query'],
  },
  execute: async (input) => {
    const query = input.query as string;
    const count = Math.min(Math.max(1, Number(input.count) || 8), 20);
    const market = (input.market as string) || 'zh-CN';
    const freshness = input.freshness as string | undefined;

    try {

      const state = useSettingsStore.getState();

      const providerType = state.webSearchProvider || 'bing';
      const apiKey = state.webSearchApiKey;
      const baseUrl = state.webSearchBaseUrl;

      // SearXNG doesn't need API key
      if (providerType !== 'searxng' && !apiKey) {
        return '未配置搜索 API Key。请在设置 → 网络搜索中配置搜索引擎的 API Key。\n\nNo search API Key configured. Please go to Settings → Web Search to configure your search engine API Key.';
      }
      if (providerType === 'searxng' && !baseUrl) {
        return '未配置 SearXNG 服务地址。请在设置 → 网络搜索中配置 SearXNG 实例地址。\n\nNo SearXNG URL configured. Please go to Settings → Web Search to configure your SearXNG instance URL.';
      }

      const { createSearchProvider } = await import('../search/providers');
      const provider = createSearchProvider(providerType, apiKey, baseUrl);
      const response = await provider.search(query, { count, market, freshness });

      if (response.results.length === 0) {
        return `没有找到与 "${query}" 相关的搜索结果。`;
      }

      // Build output with hidden JSON marker for UI parsing + readable text for LLM
      const jsonMarker = `<!--SEARCH_JSON:${JSON.stringify(response.results)}-->`;

      const lines = response.results.map((r, i) => {
        const domain = r.source || '';
        return `${i + 1}. **${r.title}** — ${domain}\n   ${r.snippet}\n   🔗 ${r.url}`;
      });

      return `${jsonMarker}\n\n搜索结果 (共 ${response.results.length} 条):\n\n${lines.join('\n\n')}`;
    } catch (err) {
      return `搜索出错: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * http_fetch tool — make HTTP requests via Tauri (bypasses CORS)
 */
const httpFetchTool: ToolDefinition = {
  name: 'http_fetch',
  description: 'Make an HTTP request to any URL. Uses Tauri native HTTP client which bypasses CORS restrictions. More reliable and cross-platform than curl via run_command.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to request' },
      method: { type: 'string', description: 'HTTP method: GET, POST, PUT, DELETE, PATCH (default: GET)' },
      headers: { type: 'object', description: 'Optional HTTP headers as key-value pairs' },
      body: { type: 'string', description: 'Optional request body (for POST/PUT/PATCH)' },
    },
    required: ['url'],
  },
  execute: async (input) => {
    const url = input.url as string;
    const method = ((input.method as string) || 'GET').toUpperCase();
    const headers = (input.headers as Record<string, string>) || {};
    const body = input.body as string | undefined;

    try {
      const fetchFn = await getTauriFetch();

      const options: RequestInit = {
        method,
        headers,
      };
      if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        options.body = body;
      }

      const response = await fetchFn(url, options);

      const MAX_RESPONSE_LENGTH = 50000;
      let responseBody = await response.text();

      // Pretty-print JSON only if response is small enough to avoid memory spikes
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json') && responseBody.length <= MAX_RESPONSE_LENGTH * 2) {
        try {
          responseBody = JSON.stringify(JSON.parse(responseBody), null, 2);
        } catch {
          // Not valid JSON despite content-type; use raw text
        }
      }

      if (responseBody.length > MAX_RESPONSE_LENGTH) {
        responseBody = responseBody.slice(0, MAX_RESPONSE_LENGTH) + `\n\n... [Truncated: response was ${responseBody.length} chars, showing first ${MAX_RESPONSE_LENGTH}]`;
      }

      return `HTTP ${response.status} ${response.statusText}\n\n${responseBody}`;
    } catch (err) {
      return `Error making HTTP request: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * delegate_to_agent tool — delegate a task to a specialist subagent
 */
const delegateToAgentTool: ToolDefinition = {
  name: 'delegate_to_agent',
  description: '将任务委派给专门的代理独立执行，完成后返回结果。适用于任务匹配某个代理专长的场景。',
  inputSchema: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: '代理名称' },
      task: { type: 'string', description: '委派的任务描述' },
      context: { type: 'string', description: '附加上下文（可选）' },
    },
    required: ['agent_name', 'task'],
  },
  execute: async (input) => {
    const agentName = input.agent_name as string;
    const task = input.task as string;
    const context = input.context as string | undefined;

    // 1. Look up agent
    const agent = agentRegistry.getAgent(agentName);
    if (!agent) {
      const available = agentRegistry.getAvailableAgents()
        .filter((a) => a.name !== 'abu')
        .map((a) => `${a.name} (${a.description})`)
        .join(', ');
      return `Error: 代理 "${agentName}" 未找到。可用代理: ${available || '无'}`;
    }

    // 2. Check if disabled
    const { disabledAgents } = useSettingsStore.getState();
    if (disabledAgents.includes(agentName)) {
      return `Error: 代理 "${agentName}" 已被停用。`;
    }

    // 3. Get parent loop context
    const loopCtx = getCurrentLoopContext();

    // 4. Set agent status indicator

    useChatStore.getState().setAgentStatus('tool-calling', 'delegate_to_agent', agentName);

    // 5. Build onProgress callback for subagent visualization
    let onProgress: ((event: SubagentProgressEvent) => void) | undefined;

    if (loopCtx) {
      // Find the parent delegate step ID from toolCallToStepId
      // The tool call ID for this execution should be the last entry mapped
      let parentStepId: string | undefined;
      for (const [, sId] of loopCtx.toolCallToStepId) {
        parentStepId = sId; // Will end up as last entry
      }
      // More precise: find step with toolName=delegate_to_agent and status=running
      if (!parentStepId) {
        const exec = loopCtx.eventRouter.getCurrentStepId(loopCtx.loopId);
        if (exec) parentStepId = exec;
      }

      if (parentStepId) {
        const childIdMap = new Map<string, string>(); // subagent toolCallId -> childStepId
        const capturedParentStepId = parentStepId;

        onProgress = (event) => {
          if (event.type === 'tool-start') {
            const childStepId = loopCtx.eventRouter.addChildStepToDelegate(
              loopCtx.loopId,
              capturedParentStepId,
              { toolName: event.toolName, toolInput: event.toolInput }
            );
            if (childStepId) {
              childIdMap.set(event.id, childStepId);
            }
          } else if (event.type === 'tool-end') {
            const childStepId = childIdMap.get(event.id);
            if (childStepId) {
              loopCtx.eventRouter.completeChildStep(
                loopCtx.loopId,
                capturedParentStepId,
                childStepId,
                event.result,
                event.error
              );
            }
          }
        };
      }
    }

    // 6. Extract parent conversation summary for context injection
    let parentConversationSummary: string | undefined;
    try {
      const chatState = useChatStore.getState();
      const activeConvId = chatState.activeConversationId;
      if (activeConvId) {
        const messages = chatState.conversations[activeConvId]?.messages ?? [];
        parentConversationSummary = extractParentConversationSummary(messages);
      }
    } catch {
      // Non-critical: proceed without parent context
    }

    // 7. Create per-subagent AbortController (linked to parent)
    const { signal: subagentSignal, cleanup: subagentCleanup } = createSubagentController(
      agentName,
      loopCtx?.signal
    );

    // 8. Execute subagent
    try {
      const result = await runSubagentLoop({
        agent,
        task,
        context,
        parentConversationSummary,
        signal: subagentSignal,
        commandConfirmCallback: loopCtx?.commandConfirmCallback,
        filePermissionCallback: loopCtx?.filePermissionCallback,
        onProgress,
      });

      // Clear this agent from tracking and cleanup
      subagentCleanup();
      useChatStore.getState().removeActiveAgent(agentName);
      return result;
    } catch (err) {
      subagentCleanup();
      useChatStore.getState().removeActiveAgent(agentName);
      throw err;
    }
  },
};

/**
 * update_memory tool — allows agents to persist learnings across sessions
 *
 * Supports three actions:
 * - append: add new content to the end (default, backward compatible)
 * - rewrite: replace entire memory file (for reorganizing/cleaning up)
 * - clear: erase all memory
 */
const updateMemoryTool: ToolDefinition = {
  name: 'update_memory',
  description: '管理持久记忆（AI 积累的知识）。scope="user" 保存个人偏好（跨项目），scope="project" 保存项目知识（仅当前工作区）。注意：项目规则（.abu/ABU.md）由用户手动维护，不要用此工具修改规则。',
  inputSchema: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: '要更新记忆的代理名称' },
      action: {
        type: 'string',
        description: '操作类型: append(追加) / rewrite(重写整理) / clear(清空)',
        enum: ['append', 'rewrite', 'clear'],
      },
      content: { type: 'string', description: '记忆内容（append 和 rewrite 时必填）' },
      scope: {
        type: 'string',
        description: '记忆范围: user(个人级，跨项目永久保持) / project(项目级，仅当前工作区)',
        enum: ['user', 'project'],
      },
    },
    required: ['agent_name'],
  },
  execute: async (input) => {
    const agentName = input.agent_name as string;
    const action = (input.action as string) || 'append';
    const content = (input.content as string) || '';
    const scope = (input.scope as string) || 'user';

    try {
      // Project-level memory
      if (scope === 'project') {
        const workspacePath = useWorkspaceStore.getState().currentPath;
        if (!workspacePath) {
          return '错误：当前没有设置工作区，无法使用项目级记忆。请先设置工作区路径。';
        }
        switch (action) {
          case 'rewrite':
            if (!content) return '错误：rewrite 操作需要提供 content。';
            await saveProjectMemory(workspacePath, content);
            return `已重写项目记忆（${workspacePath}）。`;
          case 'clear':
            await clearProjectMemory(workspacePath);
            return `已清空项目记忆（${workspacePath}）。`;
          case 'append':
          default:
            if (!content) return '错误：append 操作需要提供 content。';
            await appendProjectMemory(workspacePath, content);
            return `已追加项目记忆（${workspacePath}）。`;
        }
      }

      // User-level memory (original logic)
      switch (action) {
        case 'rewrite':
          if (!content) return '错误：rewrite 操作需要提供 content。';
          await saveAgentMemory(agentName, content);
          return `已重写 ${agentName} 的记忆。`;
        case 'clear':
          await clearAgentMemory(agentName);
          return `已清空 ${agentName} 的记忆。`;
        case 'append':
        default:
          if (!content) return '错误：append 操作需要提供 content。';
          await appendAgentMemory(agentName, content);
          return `已追加 ${agentName} 的记忆。`;
      }
    } catch (err) {
      return `Error updating memory: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * todo_write tool — create or update a structured task plan
 */
const todoWriteTool: ToolDefinition = {
  name: 'todo_write',
  description: '创建或更新任务计划。可以批量设置计划项，或更新单个项的状态。计划会在每轮对话中注入，确保你始终能看到当前进度。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '操作类型: set(批量设置计划) / add(添加单个) / update(更新状态)',
        enum: ['set', 'add', 'update'],
      },
      items: {
        type: 'array',
        items: { type: 'object' },
        description: '计划项列表（用于 set 和 add 操作）。每项应包含 content(string) 和可选 status(string: pending/in_progress/completed/cancelled)',
      },
      todo_id: { type: 'string', description: '要更新的计划项 ID（用于 update 操作）' },
      status: { type: 'string', description: '新状态（用于 update 操作）' },
      content: { type: 'string', description: '新内容（用于 update 或 add 操作）' },
    },
    required: ['action'],
  },
  execute: async (input) => {
    const action = input.action as string;

    // Get conversation ID from chatStore

    const conversationId = useChatStore.getState().activeConversationId;
    if (!conversationId) {
      return 'Error: 没有活跃会话';
    }

    switch (action) {
      case 'set': {
        const items = (input.items as Array<{ content: string; status?: string }>) ?? [];
        if (items.length === 0) return 'Error: 需要提供计划项列表';
        const result = setTodos(conversationId, items.map(i => ({
          content: i.content,
          status: (i.status as TodoStatus) ?? 'pending',
        })));
        return `已创建 ${result.length} 个计划项。\n${formatTodosForPrompt(conversationId)}`;
      }
      case 'add': {
        const content = (input.content as string) ?? (input.items as Array<{ content: string }>)?.[0]?.content;
        if (!content) return 'Error: 需要提供内容';
        const item = addTodo(conversationId, content);
        return `已添加计划项: ${item.content} (ID: ${item.id})`;
      }
      case 'update': {
        const todoId = input.todo_id as string;
        const status = input.status as string | undefined;
        const content = input.content as string | undefined;
        if (!todoId) return 'Error: 需要提供 todo_id';
        const updated = updateTodo(conversationId, todoId, {
          status: status as TodoStatus | undefined,
          content,
        });
        if (!updated) return `Error: 计划项 ${todoId} 不存在`;
        return `已更新计划项: ${updated.content} → ${updated.status}`;
      }
      default:
        return `Error: 未知操作 "${action}"。可用操作: set, add, update`;
    }
  },
};

/**
 * todo_read tool — read current task plan
 */
const todoReadTool: ToolDefinition = {
  name: 'todo_read',
  description: '读取当前任务计划和进度。返回所有计划项及其状态。',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async () => {

    const conversationId = useChatStore.getState().activeConversationId;
    if (!conversationId) {
      return 'Error: 没有活跃会话';
    }

    const todos = getTodos(conversationId);
    if (todos.length === 0) {
      return '当前没有任务计划。使用 todo_write 创建计划。';
    }

    const formatted = formatTodosForPrompt(conversationId);
    // Include IDs for update reference
    const details = todos.map(t => `- ID: ${t.id} | ${t.status} | ${t.content}`).join('\n');
    return `${formatted}\n\n详细信息（含 ID）:\n${details}`;
  },
};

/**
 * manage_scheduled_task tool — create, list, update, delete, pause, or resume scheduled tasks
 */
const manageScheduledTaskTool: ToolDefinition = {
  name: 'manage_scheduled_task',
  description: '创建、查看、更新、删除、暂停或恢复定时任务。当用户需要定期/定时自动执行某操作时使用。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update', 'delete', 'pause', 'resume'],
        description: '操作类型',
      },
      name: { type: 'string', description: '任务名称（create/update 时使用）' },
      description: { type: 'string', description: '任务描述（可选）' },
      prompt: { type: 'string', description: '每次执行时的指令内容（create/update 时使用）' },
      frequency: {
        type: 'string',
        enum: ['hourly', 'daily', 'weekly', 'weekdays', 'manual'],
        description: '执行频率',
      },
      time_hour: { type: 'number', description: '小时 0-23' },
      time_minute: { type: 'number', description: '分钟 0-59' },
      day_of_week: { type: 'number', description: '星期几 0=周日..6=周六（weekly 时使用）' },
      skill_name: { type: 'string', description: '绑定技能名称（可选）' },
      workspace_path: { type: 'string', description: '工作区路径（可选）' },
      task_id: { type: 'string', description: '任务 ID（update/delete/pause/resume 时必填）' },
      status_filter: {
        type: 'string',
        enum: ['active', 'paused', 'all'],
        description: '列表过滤条件（list 时使用，默认 all）',
      },
    },
    required: ['action'],
  },
  execute: async (input) => {
    const action = input.action as string;
    const store = useScheduleStore.getState();

    switch (action) {
      case 'create': {
        const name = input.name as string | undefined;
        const prompt = input.prompt as string | undefined;
        const frequency = input.frequency as ScheduleFrequency | undefined;

        if (!name) return 'Error: 缺少任务名称 (name)';
        if (!prompt) return 'Error: 缺少执行指令 (prompt)';
        if (!frequency) return 'Error: 缺少执行频率 (frequency)';

        // Duplicate name check — prevent LLM from creating redundant tasks
        const existingTasks = Object.values(store.tasks);
        const duplicate = existingTasks.find(
          (t) => t.name === name && t.status === 'active'
        );
        if (duplicate) {
          return `Error: 已存在同名活跃任务「${name}」(ID: ${duplicate.id})，请勿重复创建。如需修改请使用 update 操作。`;
        }

        // Build time config with defaults
        const timeHour = input.time_hour as number | undefined;
        const timeMinute = input.time_minute as number | undefined;
        const dayOfWeek = input.day_of_week as number | undefined;

        // Validate ranges
        if (timeHour !== undefined && (timeHour < 0 || timeHour > 23)) {
          return 'Error: time_hour 必须在 0-23 之间';
        }
        if (timeMinute !== undefined && (timeMinute < 0 || timeMinute > 59)) {
          return 'Error: time_minute 必须在 0-59 之间';
        }
        if (dayOfWeek !== undefined && (dayOfWeek < 0 || dayOfWeek > 6)) {
          return 'Error: day_of_week 必须在 0-6 之间 (0=周日)';
        }

        // Default time: 9:00 for daily/weekly/weekdays, 0 minute for hourly
        const schedule: ScheduleConfig = { frequency };
        if (frequency === 'hourly') {
          schedule.time = { hour: 0, minute: timeMinute ?? 0 };
        } else if (frequency !== 'manual') {
          schedule.time = { hour: timeHour ?? 9, minute: timeMinute ?? 0 };
        }
        if (frequency === 'weekly') {
          schedule.dayOfWeek = dayOfWeek ?? 1; // default Monday
        }

        const taskId = store.createTask({
          name,
          description: input.description as string | undefined,
          prompt,
          schedule,
          skillName: input.skill_name as string | undefined,
          workspacePath: input.workspace_path as string | undefined,
        });

        const task = useScheduleStore.getState().tasks[taskId];
        const nextRun = task?.nextRunAt
          ? new Date(task.nextRunAt).toLocaleString('zh-CN')
          : '无';

        return `成功创建定时任务「${name}」\nID: ${taskId}\n频率: ${frequency}\n下次执行: ${nextRun}`;
      }

      case 'list': {
        const filter = (input.status_filter as string) || 'all';
        const allTasks = Object.values(store.tasks);

        const filtered = filter === 'all'
          ? allTasks
          : allTasks.filter((t) => t.status === filter);

        if (filtered.length === 0) {
          return filter === 'all'
            ? '当前没有定时任务。'
            : `没有${filter === 'active' ? '活跃' : '已暂停'}的定时任务。`;
        }

        const lines = filtered.map((t) => {
          const nextRun = t.nextRunAt
            ? new Date(t.nextRunAt).toLocaleString('zh-CN')
            : '无';
          return `- [${t.status === 'active' ? '✅' : '⏸️'}] ${t.name} (ID: ${t.id})\n  频率: ${t.schedule.frequency} | 下次执行: ${nextRun} | 已执行: ${t.totalRuns} 次`;
        });

        return `定时任务列表 (${filtered.length} 个):\n\n${lines.join('\n')}`;
      }

      case 'update': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return 'Error: 缺少 task_id';

        const existing = store.tasks[taskId];
        if (!existing) return `Error: 找不到任务 (ID: ${taskId})`;

        const updateData: Record<string, unknown> = {};
        if (input.name !== undefined) updateData.name = input.name;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.prompt !== undefined) updateData.prompt = input.prompt;
        if (input.skill_name !== undefined) updateData.skillName = input.skill_name;
        if (input.workspace_path !== undefined) updateData.workspacePath = input.workspace_path;

        // Build schedule update if any schedule field changed
        const frequency = input.frequency as ScheduleFrequency | undefined;
        const timeHour = input.time_hour as number | undefined;
        const timeMinute = input.time_minute as number | undefined;
        const dayOfWeek = input.day_of_week as number | undefined;

        if (frequency || timeHour !== undefined || timeMinute !== undefined || dayOfWeek !== undefined) {
          const newSchedule: ScheduleConfig = {
            frequency: frequency || existing.schedule.frequency,
            time: {
              hour: timeHour ?? existing.schedule.time?.hour ?? 9,
              minute: timeMinute ?? existing.schedule.time?.minute ?? 0,
            },
          };
          if (newSchedule.frequency === 'weekly') {
            newSchedule.dayOfWeek = dayOfWeek ?? existing.schedule.dayOfWeek ?? 1;
          }
          updateData.schedule = newSchedule;
        }

        store.updateTask(taskId, updateData as Parameters<typeof store.updateTask>[1]);

        return `成功更新定时任务「${input.name || existing.name}」(ID: ${taskId})`;
      }

      case 'delete': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return 'Error: 缺少 task_id';

        const existing = store.tasks[taskId];
        if (!existing) return `Error: 找不到任务 (ID: ${taskId})`;

        const taskName = existing.name;
        store.deleteTask(taskId);
        return `成功删除定时任务「${taskName}」(ID: ${taskId})`;
      }

      case 'pause': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return 'Error: 缺少 task_id';

        const existing = store.tasks[taskId];
        if (!existing) return `Error: 找不到任务 (ID: ${taskId})`;
        if (existing.status === 'paused') return `任务「${existing.name}」已经处于暂停状态。`;

        store.pauseTask(taskId);
        return `已暂停定时任务「${existing.name}」(ID: ${taskId})`;
      }

      case 'resume': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return 'Error: 缺少 task_id';

        const existing = store.tasks[taskId];
        if (!existing) return `Error: 找不到任务 (ID: ${taskId})`;
        if (existing.status === 'active') return `任务「${existing.name}」已经处于活跃状态。`;

        store.resumeTask(taskId);
        const updated = useScheduleStore.getState().tasks[taskId];
        const nextRun = updated?.nextRunAt
          ? new Date(updated.nextRunAt).toLocaleString('zh-CN')
          : '无';
        return `已恢复定时任务「${existing.name}」(ID: ${taskId})\n下次执行: ${nextRun}`;
      }

      default:
        return `Error: 未知操作 "${action}"。可用操作: create, list, update, delete, pause, resume`;
    }
  },
};

// --- save_skill / save_agent: bypass pathSafety for ~/.abu/ writes ---

import { ITEM_NAME_RE } from '../../utils/validation';

function createSaveItemTool(kind: 'skill' | 'agent'): ToolDefinition {
  const isSkill = kind === 'skill';
  const folder = isSkill ? 'skills' : 'agents';
  const fileName = isSkill ? 'SKILL.md' : 'AGENT.md';
  const label = isSkill ? '技能' : '代理';

  return {
    name: isSkill ? 'save_skill' : 'save_agent',
    description: `Save a custom ${kind} file to ~/.abu/${folder}/{name}/${fileName}. Only accepts a name and content — the path is computed internally.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `${kind} name (lowercase, hyphens allowed, e.g. "${isSkill ? 'git-commit' : 'doc-writer'}")` },
        content: { type: 'string', description: `Full ${fileName} content including YAML frontmatter` },
      },
      required: ['name', 'content'],
    },
    execute: async (input) => {
      const name = (input.name as string).trim();
      const content = input.content as string;

      if (!ITEM_NAME_RE.test(name)) {
        return `Error: ${label}名称不合法。仅允许小写字母、数字和连字符，且不能以连字符开头或结尾。收到: "${name}"`;
      }

      const info = await getSystemInfoData();
      const filePath = joinPath(info.home, '.abu', folder, name, fileName);

      await ensureParentDir(filePath);
      await writeTextFile(filePath, content);

      // Refresh discovery so the new item appears in UI immediately
      await useDiscoveryStore.getState().refresh();

      if (isSkill) {
        return `✅ ${label}「${name}」已保存到 ${filePath}\n\n你可以：\n- 到「工具箱 → 技能」查看和编辑\n- 使用 /${name} 调用此技能`;
      }
      return `✅ ${label}「${name}」已保存到 ${filePath}\n\n你可以到「工具箱 → 代理」查看和管理此代理。`;
    },
  };
}

const saveSkillTool = createSaveItemTool('skill');
const saveAgentTool = createSaveItemTool('agent');

/**
 * log_task_completion tool — records completed tasks for pattern analysis
 */
const logTaskCompletionTool: ToolDefinition = {
  name: 'log_task_completion',
  description: '任务完成后记录摘要。完成用户交办的实际任务后应调用（闲聊和简单问答不记录）。',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '一句话描述完成的任务' },
      category: {
        type: 'string',
        description: '任务分类',
        enum: ['translation', 'coding', 'research', 'writing', 'data-processing', 'file-management', 'communication', 'other'],
      },
      tools_used: {
        type: 'array',
        items: { type: 'string' },
        description: '本次使用的工具名称列表',
      },
      skill_used: { type: 'string', description: '使用的技能名称（如有）' },
      agent_used: { type: 'string', description: '委派的代理名称（如有）' },
      success: { type: 'boolean', description: '任务是否成功完成' },
    },
    required: ['summary', 'category', 'success'],
  },
  execute: async (input) => {
    try {
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
        summary: input.summary as string,
        category: input.category as TaskCategory,
        toolsUsed: (input.tools_used as string[]) ?? [],
        skillUsed: (input.skill_used as string) ?? null,
        agentUsed: (input.agent_used as string) ?? null,
        success: input.success as boolean,
        timestamp: Date.now(),
      };
      await appendTaskLog(entry);
      return '任务已记录。';
    } catch (err) {
      return `Error logging task: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * search_mcp_server — search for installable MCP servers
 */
const searchMCPServerTool: ToolDefinition = {
  name: 'search_mcp_server',
  description: '搜索可安装的 MCP Server（一种工具协议服务）。仅当你在执行任务过程中发现缺少某种工具能力（如操作 GitHub、Slack、数据库等）时才使用。注意：这不是通用软件安装工具，不要用于安装普通软件、CLI 工具或应用程序。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词，如 "github"、"slack"、"database"、"notion"' },
    },
    required: ['query'],
  },
  execute: async (input) => {
    const query = input.query as string;
    const results = searchMCPRegistry(query);
    if (results.length === 0) {
      return `未找到匹配 "${query}" 的 MCP Server。你可以用 web_search 搜索 "${query} MCP server" 寻找社区方案。`;
    }
    const lines = results.map((r) => {
      const envNeeded = Object.keys(r.env).filter((k) => r.envHints?.[k]);
      const envNote = envNeeded.length > 0 ? ` (需要: ${envNeeded.join(', ')})` : '';
      return `- **${r.name}**: ${r.description}${envNote}`;
    });
    return `找到 ${results.length} 个可用的 MCP Server:\n${lines.join('\n')}\n\n使用 install_mcp_server 安装。安装前请告知用户并获得确认。`;
  },
};

/**
 * install_mcp_server — install and connect an MCP server
 */
const installMCPServerTool: ToolDefinition = {
  name: 'install_mcp_server',
  description: '安装并连接 MCP Server。安装前必须告知用户并获得确认。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'MCP Server 名称（来自 search_mcp_server 的结果）' },
      env: {
        type: 'object',
        description: '环境变量键值对（如 API Key 等，用户提供的值）',
      },
    },
    required: ['name'],
  },
  execute: async (input) => {
    const name = input.name as string;
    const env = input.env as Record<string, string> | undefined;

    const entry = getRegistryEntry(name);
    if (!entry) {
      return `未找到名为 "${name}" 的 MCP Server。请先用 search_mcp_server 搜索。`;
    }

    try {
      const result = await installMCPServer(entry, env);
      return result.message;
    } catch (err) {
      return `安装失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * manage_file_watch — create, remove, toggle, or list file watch rules
 */
const manageFileWatchTool: ToolDefinition = {
  name: 'manage_file_watch',
  description: '管理文件监听规则。当检测到目录中的文件变化时，自动触发后台任务。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '操作类型',
        enum: ['add', 'remove', 'toggle', 'list'],
      },
      // For 'add'
      path: { type: 'string', description: '监听的目录路径（add 时必填）' },
      pattern: { type: 'string', description: '文件名过滤，如 "*.pdf"、"*.xlsx"（可选）' },
      event: { type: 'string', description: '监听事件类型: create / modify / any（默认 any）', enum: ['create', 'modify', 'any'] },
      prompt: { type: 'string', description: '触发时的提示词，支持 {filePath} 和 {fileName} 占位符（add 时必填）' },
      skill_name: { type: 'string', description: '触发时使用的技能名称（可选）' },
      // For 'remove' / 'toggle'
      rule_id: { type: 'string', description: '规则 ID（remove/toggle 时必填）' },
    },
    required: ['action'],
  },
  execute: async (input) => {
    const action = input.action as string;

    try {
      switch (action) {
        case 'list': {
          const rules = await listWatchRules();
          if (rules.length === 0) return '当前没有文件监听规则。';
          const lines = rules.map((r) => {
            const status = r.enabled ? (r.active ? '运行中' : '已启用') : '已禁用';
            const patternStr = r.pattern ? ` (${r.pattern})` : '';
            return `- [${status}] ${r.id}: ${r.path}${patternStr} → ${r.event} → "${r.prompt}"`;
          });
          return `文件监听规则 (${rules.length}):\n${lines.join('\n')}`;
        }
        case 'add': {
          const path = input.path as string;
          const prompt = input.prompt as string;
          if (!path || !prompt) return '错误：add 操作需要 path 和 prompt。';
          const rule: FileWatchRule = {
            id: Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
            path,
            pattern: input.pattern as string | undefined,
            event: (input.event as FileWatchRule['event']) ?? 'any',
            prompt,
            skillName: input.skill_name as string | undefined,
            enabled: true,
          };
          await addWatchRule(rule);
          return `已创建文件监听规则 ${rule.id}，监听 ${path}。`;
        }
        case 'remove': {
          const ruleId = input.rule_id as string;
          if (!ruleId) return '错误：remove 操作需要 rule_id。';
          await removeWatchRule(ruleId);
          return `已删除规则 ${ruleId}。`;
        }
        case 'toggle': {
          const ruleId = input.rule_id as string;
          if (!ruleId) return '错误：toggle 操作需要 rule_id。';
          await toggleWatchRule(ruleId);
          return `已切换规则 ${ruleId} 的启用状态。`;
        }
        default:
          return `未知操作: ${action}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ============================================================
// Clipboard Tools
// ============================================================

const clipboardReadTool: ToolDefinition = {
  name: 'clipboard_read',
  description: 'Read text content from the system clipboard.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  execute: async () => {
    try {
      const text = await clipboardReadText();
      return text || '[clipboard is empty]';
    } catch (err) {
      return `Error reading clipboard: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const clipboardWriteTool: ToolDefinition = {
  name: 'clipboard_write',
  description: 'Write text content to the system clipboard.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text content to write to clipboard' },
    },
    required: ['text'],
  },
  execute: async (input) => {
    try {
      await clipboardWriteText(input.text as string);
      return 'Text copied to clipboard.';
    } catch (err) {
      return `Error writing to clipboard: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ============================================================
// System Notification Tool
// ============================================================

const systemNotifyTool: ToolDefinition = {
  name: 'system_notify',
  description: 'Send a system desktop notification to the user. Use for important alerts or task completion notices.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Notification title' },
      body: { type: 'string', description: 'Notification body text' },
    },
    required: ['title', 'body'],
  },
  execute: async (input) => {
    try {
      let permitted = await isPermissionGranted();
      if (!permitted) {
        const permission = await requestPermission();
        permitted = permission === 'granted';
      }
      if (!permitted) {
        return 'Notification permission denied by the user.';
      }
      sendNotification({ title: input.title as string, body: input.body as string });
      return 'Notification sent.';
    } catch (err) {
      return `Error sending notification: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// --- Computer Use: unified tool (screenshot + keyboard/mouse) ---
// Gated by computerUseEnabled setting — user must explicitly authorize in Settings.
// macOS also requires Screen Recording permission (screenshot) and Accessibility permission (keyboard/mouse).
//
// Design: single "computer" tool with action dispatch, following industry convention
// (Anthropic Computer Use API, OpenAI CUA). Saves ~500 tokens vs 7 separate tools.

let lastScreenScaleFactor = 1;
const SCREENSHOT_MAX_WIDTH = 1280;
const AUTO_SCREENSHOT_DELAY_MS = 800;

// Batch mode flags — controlled by agentLoop for sequential computer use batches
let computerUseBatchMode = false;
let skipAutoScreenshot = false;

export function setComputerUseBatchMode(value: boolean) { computerUseBatchMode = value; }
export function setSkipAutoScreenshot(value: boolean) { skipAutoScreenshot = value; }

/** Map LLM coordinates (in scaled screenshot space) back to real screen pixels. */
function toScreenCoords(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(x * lastScreenScaleFactor),
    y: Math.round(y * lastScreenScaleFactor),
  };
}

/**
 * Take a lightweight auto-screenshot after an action.
 * IMPORTANT: Assumes Abu window is ALREADY hidden (caller must not show it before calling).
 * This function waits for UI to settle, captures, then shows the window.
 */
async function takeAutoScreenshot(): Promise<ToolResultContent[]> {
  // Wait for UI to settle after the action (e.g. click animation, page load)
  await new Promise(r => setTimeout(r, AUTO_SCREENSHOT_DELAY_MS));
  // Window should already be hidden by the caller — just capture
  try {
    const result = await invoke<{ base64: string; width: number; height: number; scale_factor: number }>('capture_screen', {
      x: null, y: null, width: null, height: null,
      maxWidth: SCREENSHOT_MAX_WIDTH,
    });
    lastScreenScaleFactor = result.scale_factor;
    return [
      { type: 'text', text: `Auto-screenshot after action: ${result.width}x${result.height} (scale: ${result.scale_factor.toFixed(2)}x)\nExamine the screenshot to verify the action result and determine next steps.` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: result.base64 } },
    ];
  } catch (e) {
    return [{ type: 'text', text: `Auto-screenshot failed: ${e instanceof Error ? e.message : String(e)}` }];
  }
  // NOTE: window_show is handled by the caller's finally block
}

async function executeScreenshot(input: Record<string, unknown>): Promise<ToolResult> {
  // Check macOS permissions before attempting screenshot
  try {
    const perms = await invoke<{ screen_recording: boolean; accessibility: boolean }>('check_macos_permissions');
    if (!perms.screen_recording) {
      // Try to trigger the system permission prompt
      await invoke<boolean>('request_screen_recording');
      return 'Error: 没有录屏权限。请在 系统设置 → 隐私与安全性 → 录屏与系统录音 中授权 Abu，然后重启 Abu。\n\nNo Screen Recording permission. Please grant Abu access in System Settings → Privacy & Security → Screen Recording, then restart Abu.';
    }
  } catch {
    // Non-macOS or FFI unavailable — proceed
  }

  // Hide Abu window so it doesn't appear in the screenshot
  try { await invoke('window_hide'); } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 300));

  try {
    const result = await invoke<{ base64: string; width: number; height: number; scale_factor: number }>('capture_screen', {
      x: input.x != null ? Math.round((input.x as number) * lastScreenScaleFactor) : null,
      y: input.y != null ? Math.round((input.y as number) * lastScreenScaleFactor) : null,
      width: input.width != null ? Math.round((input.width as number) * lastScreenScaleFactor) : null,
      height: input.height != null ? Math.round((input.height as number) * lastScreenScaleFactor) : null,
      maxWidth: SCREENSHOT_MAX_WIDTH,
    });
    lastScreenScaleFactor = result.scale_factor;

    // Save screenshot — prefer workspace, then desktop (not ~/Library which is inaccessible)
    let savedPath = '';
    try {
      const workspacePath = useWorkspaceStore.getState().currentPath;
      const saveDir = workspacePath || await desktopDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `screenshot-${timestamp}.png`;
      const filePath = joinPath(saveDir, fileName);
      // Decode base64 and write as binary file
      const binaryStr = atob(result.base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      await writeBinFile(filePath, bytes);
      savedPath = filePath;
    } catch (e) {
      console.warn('Failed to save screenshot file:', e);
    }

    const saveInfo = savedPath ? `\nScreenshot saved to: ${savedPath}` : '';
    return [
      { type: 'text', text: `Screenshot: ${result.width}x${result.height} (scale: ${result.scale_factor.toFixed(2)}x)${saveInfo}\nThe screenshot image is attached. Examine it carefully to identify UI elements and their coordinates. Do NOT use screencapture command to take another screenshot.` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: result.base64 } },
    ];
  } finally {
    try { await invoke('window_show'); } catch { /* ignore */ }
  }
}

const computerTool: ToolDefinition = {
  name: 'computer',
  description: `Interact with the computer screen via screenshot, mouse, and keyboard. Use action parameter to specify the operation.

Actions:
- screenshot: Capture the screen (Abu window auto-hidden). Optional: x, y, width, height to crop.
- click: Click at coordinate. Params: x, y, button (left/right/middle/double, default left).
- move: Move mouse to coordinate. Params: x, y.
- scroll: Scroll at coordinate. Params: x, y, direction (up/down/left/right), amount (ticks, default 3).
- drag: Drag from one point to another. Params: startX, startY, endX, endY.
- type: Type text (Chinese/CJK text auto-uses clipboard paste). Params: text.
- key: Press key combo. Params: key (e.g. Return, Tab, a), modifiers (e.g. ["ctrl","shift"]).
- wait: Wait for specified milliseconds. Params: duration (ms, default 1000, max 10000). Use between operations to let UI load.

All coordinates use the screenshot pixel space (max width: ${SCREENSHOT_MAX_WIDTH}px). Screenshots are auto-scaled to fit; coordinates are auto-mapped back to real screen pixels.
After click/type/key/scroll/drag actions, an auto-screenshot is taken and returned so you can verify the result immediately.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform: screenshot, click, move, scroll, drag, type, key, wait',
      },
      // Coordinate params (for click, move, scroll, screenshot crop)
      x: { type: 'number', description: 'X coordinate (screenshot space)' },
      y: { type: 'number', description: 'Y coordinate (screenshot space)' },
      // Click
      button: { type: 'string', description: 'Mouse button: left, right, middle, double (default: left)' },
      // Scroll
      direction: { type: 'string', description: 'Scroll direction: up, down, left, right' },
      amount: { type: 'number', description: 'Scroll ticks (default 3)' },
      // Drag
      startX: { type: 'number', description: 'Drag start X' },
      startY: { type: 'number', description: 'Drag start Y' },
      endX: { type: 'number', description: 'Drag end X' },
      endY: { type: 'number', description: 'Drag end Y' },
      // Screenshot crop
      width: { type: 'number', description: 'Crop width (screenshot only)' },
      height: { type: 'number', description: 'Crop height (screenshot only)' },
      // Type
      text: { type: 'string', description: 'Text to type' },
      // Key
      key: { type: 'string', description: 'Key name (Return, Tab, Escape, Space, ArrowUp, a, etc.)' },
      modifiers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Modifier keys: ctrl, shift, alt, meta',
      },
      // Wait
      duration: { type: 'number', description: 'Wait duration in ms (default 1000, max 10000)' },
      // Display control
      show_user: {
        type: 'boolean',
        description: 'Whether to display the screenshot to the user in chat. Set true when user asks to see the screen. Default: true for screenshot action, false for other actions.',
      },
    },
    required: ['action'],
  },
  execute: async (input): Promise<ToolResult> => {
    const enabled = useSettingsStore.getState().computerUseEnabled;
    if (!enabled) {
      throw new Error('Computer Use is not enabled. Please ask the user to enable it in Settings → General → Computer Use.');
    }

    const action = input.action as string;

    // Wait action — no permission needed
    if (action === 'wait') {
      const ms = Math.min(Math.max((input.duration as number) || 1000, 100), 10000);
      await new Promise(r => setTimeout(r, ms));
      return `Waited ${ms}ms`;
    }

    // Check Accessibility permission for mouse/keyboard actions (macOS)
    if (action !== 'screenshot') {
      try {
        const perms = await invoke<{ screen_recording: boolean; accessibility: boolean }>('check_macos_permissions');
        if (!perms.accessibility) {
          return 'Error: 没有辅助功能权限。请在 系统设置 → 隐私与安全性 → 辅助功能 中授权 Abu，然后重启 Abu。\n\nNo Accessibility permission. Please grant Abu access in System Settings → Privacy & Security → Accessibility, then restart Abu.';
        }
      } catch {
        // Non-macOS or FFI unavailable — proceed
      }
    }

    // Hide Abu window during operations so it doesn't block click targets
    // In batch mode, agentLoop handles window hide/show at batch level
    const needsHideWindow = !computerUseBatchMode && ['click', 'move', 'scroll', 'drag', 'type', 'key'].includes(action);
    if (needsHideWindow) {
      try { await invoke('window_hide'); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 100)); // Let window animate away
    }

    // Actions that should auto-screenshot after execution
    const autoScreenshotActions = ['click', 'type', 'key', 'scroll', 'drag'];

    try {
      let actionResult: string;
      switch (action) {
        case 'screenshot':
          return await executeScreenshot(input);

        case 'click': {
          const sc = toScreenCoords(input.x as number, input.y as number);
          actionResult = await invoke<string>('mouse_click', {
            x: sc.x, y: sc.y,
            button: (input.button as string) || undefined,
          });
          break;
        }

        case 'move': {
          const sc = toScreenCoords(input.x as number, input.y as number);
          actionResult = await invoke<string>('mouse_move', { x: sc.x, y: sc.y });
          break;
        }

        case 'scroll': {
          const sc = toScreenCoords(input.x as number, input.y as number);
          actionResult = await invoke<string>('mouse_scroll', {
            x: sc.x, y: sc.y,
            direction: input.direction as string,
            amount: (input.amount as number) || undefined,
          });
          break;
        }

        case 'drag': {
          const start = toScreenCoords(input.startX as number, input.startY as number);
          const end = toScreenCoords(input.endX as number, input.endY as number);
          actionResult = await invoke<string>('mouse_drag', {
            startX: start.x, startY: start.y,
            endX: end.x, endY: end.y,
          });
          break;
        }

        case 'type': {
          const text = input.text as string;
          // Detect non-ASCII (Chinese/CJK etc.) — use clipboard + Cmd+V for reliable input
          const hasNonAscii = /[^\u0020-\u007E\t\n\r]/.test(text);
          if (hasNonAscii) {
            await clipboardWriteText(text);
            await new Promise(r => setTimeout(r, 50));
            await invoke<string>('keyboard_press', { key: 'v', modifiers: ['meta'] });
            actionResult = `Typed (via paste): ${text} (${text.length} characters)`;
          } else {
            actionResult = await invoke<string>('keyboard_type', { text });
          }
          break;
        }

        case 'key':
          actionResult = await invoke<string>('keyboard_press', {
            key: input.key as string,
            modifiers: (input.modifiers as string[]) || undefined,
          });
          break;

        default:
          return `Unknown action: ${action}. Valid actions: screenshot, click, move, scroll, drag, type, key, wait`;
      }

      // Auto-screenshot after UI-affecting actions so the model can see the result.
      // Window stays HIDDEN during the wait + capture — don't show it prematurely!
      // In batch mode, intermediate tools skip auto-screenshot (only last computer tool takes one).
      if (autoScreenshotActions.includes(action) && !skipAutoScreenshot) {
        const screenshotContent = await takeAutoScreenshot();
        return [
          { type: 'text', text: actionResult },
          ...screenshotContent,
        ];
      }

      return actionResult;
    } finally {
      // Restore Abu window AFTER everything is done (including auto-screenshot)
      if (needsHideWindow) {
        try { await invoke('window_show'); } catch { /* ignore */ }
      }
    }
  },
};

/**
 * read_skill_file tool — reads supporting files from a skill's directory
 */
const readSkillFileTool: ToolDefinition = {
  name: 'read_skill_file',
  description: 'Read a supporting file from an active skill\'s directory (reference docs, templates, examples, etc.).',
  inputSchema: {
    type: 'object',
    properties: {
      skill_name: { type: 'string', description: 'Name of the skill' },
      path: { type: 'string', description: 'Relative path within the skill directory, e.g. "reference.md" or "examples/api.md"' },
    },
    required: ['skill_name', 'path'],
  },
  execute: async (input) => {
    const skillName = input.skill_name as string;
    const relativePath = input.path as string;

    // Security: reject path traversal
    if (relativePath.includes('..')) {
      return 'Error: Path must not contain ".." (path traversal not allowed).';
    }

    const content = await skillLoader.loadSupportingFile(skillName, relativePath);
    if (content === null) {
      // Try listing available files to help
      const files = await skillLoader.listSupportingFiles(skillName);
      if (files.length > 0) {
        return `Error: File "${relativePath}" not found in skill "${skillName}".\nAvailable files:\n${files.map(f => `- ${f}`).join('\n')}`;
      }
      return `Error: File "${relativePath}" not found in skill "${skillName}", or skill does not exist.`;
    }

    return content;
  },
};

/**
 * request_workspace tool — asks the user to select a workspace folder
 * Used when the user's request requires file operations but no workspace is set.
 */
const requestWorkspaceTool: ToolDefinition = {
  name: 'request_workspace',
  description: '请求用户选择工作区文件夹。当用户的请求涉及文件操作但没有设置工作区时，调用此工具让用户选择工作目录。',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: '向用户解释为什么需要选择工作区，例如"你想整理文件，需要先选择一个工作目录"',
      },
    },
    required: ['reason'],
  },
  execute: async (input) => {
    const reason = input.reason as string;
    const ctx = getCurrentLoopContext();
    const convId = ctx?.conversationId ?? '';
    const result = await requestWorkspace(reason, convId);
    if (result) {
      return `用户已选择工作区：${result}`;
    }
    return '用户取消了工作区选择。请告知用户需要先选择工作目录才能进行文件操作。';
  },
};

export function registerBuiltinTools(): void {
  toolRegistry.register(getSystemInfoTool);
  toolRegistry.register(readFileTool);
  toolRegistry.register(writeFileTool);
  toolRegistry.register(editFileTool);
  toolRegistry.register(listDirectoryTool);
  toolRegistry.register(runCommandTool);
  toolRegistry.register(searchFilesTool);
  toolRegistry.register(findFilesTool);
  toolRegistry.register(useSkillTool);
  toolRegistry.register(readSkillFileTool);
  toolRegistry.register(reportPlanTool);
  toolRegistry.register(generateImageTool);
  toolRegistry.register(processImageTool);
  toolRegistry.register(httpFetchTool);
  toolRegistry.register(webSearchTool);
  toolRegistry.register(delegateToAgentTool);
  toolRegistry.register(updateMemoryTool);
  toolRegistry.register(todoWriteTool);
  toolRegistry.register(todoReadTool);
  toolRegistry.register(manageScheduledTaskTool);
  toolRegistry.register(saveSkillTool);
  toolRegistry.register(saveAgentTool);
  toolRegistry.register(logTaskCompletionTool);
  toolRegistry.register(searchMCPServerTool);
  toolRegistry.register(installMCPServerTool);
  toolRegistry.register(manageFileWatchTool);
  toolRegistry.register(clipboardReadTool);
  toolRegistry.register(clipboardWriteTool);
  toolRegistry.register(systemNotifyTool);
  toolRegistry.register(computerTool);
  toolRegistry.register(requestWorkspaceTool);
}
