import { TOOL_NAMES } from '@/core/tools/toolNames';
import { MEMBER_INSTRUCTION_STEP } from '@/core/agent/dispatchInput';
import { format } from '@/i18n';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';
import type { TranslationDict } from '@/i18n/types';
import type { BackgroundCommandRef } from '@/types';
import { commandPurpose } from '@/utils/commandPurpose';

/**
 * Shared, locale-aware tool-call label generation.
 *
 * This is the SINGLE source of truth for tool-call timeline labels (e.g.
 * "List Desktop" / "列出 Desktop", "Read file", "Result"). It is intentionally
 * a pure function keyed on (toolName, toolInput, locale) so callers can compute
 * labels at RENDER time against the current UI locale — labels are never baked
 * into persisted data. See DetailBlockView / TaskBlock for the render-time call
 * sites, and eventRouter for the live-execution producer.
 */

const BROWSER_SERVERS = new Set(['abu-browser', 'abu-browser-bridge']);

/** Check if a tool is an MCP tool (format: serverName__toolName). */
export function isMCPTool(toolName: string): boolean {
  return toolName.includes('__');
}

/** Parse MCP tool name into server and tool parts. */
export function parseMCPToolName(
  toolName: string
): { serverName: string; actualToolName: string } | null {
  if (!isMCPTool(toolName)) return null;
  const sepIndex = toolName.indexOf('__');
  return {
    serverName: toolName.substring(0, sepIndex),
    actualToolName: toolName.substring(sepIndex + 2),
  };
}

function shortCommand(command: string): string {
  return command.length > 20 ? command.slice(0, 20) + '...' : command;
}

/** A tool call whose title depends on a model-written purpose, not on any other part of its input. */
export function isCommandToolName(toolName: string): boolean {
  return toolName === TOOL_NAMES.RUN_COMMAND || toolName === 'execute' || toolName === 'shell' || toolName === 'bash';
}

function getFileName(path: string): string {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

/** A web address without its scheme, cut to 40 characters. */
export function shortUrl(url: string): string {
  const chars = Array.from(url.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''));
  return chars.length > 40 ? chars.slice(0, 40).join('') + '…' : chars.join('');
}

function dictionary(isZh: boolean): TranslationDict {
  return isZh ? zhCN : enUS;
}

/** Names of steps that need no detail from their input: [Chinese, English]. */
const PLAIN_STEP_LABELS: Record<string, [string, string]> = {
  [TOOL_NAMES.APPLY_PATCH]: ['修改文件', 'Edit files'],
  [TOOL_NAMES.RECALL]: ['回想以前的对话', 'Recall earlier conversations'],
  [TOOL_NAMES.READ_MEMORY]: ['读取记忆', 'Read memory'],
  [TOOL_NAMES.UPDATE_MEMORY]: ['更新记忆', 'Update memory'],
  [TOOL_NAMES.READ_SKILL_FILE]: ['读取技能说明', 'Read a skill file'],
  [TOOL_NAMES.SKILL_VIEW]: ['查看技能', 'View a skill'],
  [TOOL_NAMES.TOOL_SEARCH]: ['查找可用的工具', 'Look for a tool'],
  [TOOL_NAMES.GENERATE_IMAGE]: ['生成图片', 'Generate an image'],
  [TOOL_NAMES.PROCESS_IMAGE]: ['处理图片', 'Process an image'],
  [TOOL_NAMES.CLIPBOARD_READ]: ['读取剪贴板', 'Read the clipboard'],
  [TOOL_NAMES.CLIPBOARD_WRITE]: ['写入剪贴板', 'Write to the clipboard'],
  [TOOL_NAMES.SYSTEM_NOTIFY]: ['发送系统通知', 'Send a notification'],
  [TOOL_NAMES.SEND_FILE]: ['发送文件', 'Send a file'],
  [TOOL_NAMES.REQUEST_WORKSPACE]: ['请你选择工作区', 'Ask for a workspace'],
  [TOOL_NAMES.ASK_USER_QUESTION]: ['向你提问', 'Ask you a question'],
  [TOOL_NAMES.CREATE_TODO]: ['添加待办', 'Add a to-do'],
  [TOOL_NAMES.CHECK_OPEN_DOCUMENT]: ['检查打开的文档', 'Check an open document'],
  [TOOL_NAMES.PLUGIN_PREPARE]: ['准备插件', 'Prepare a plugin'],
  [TOOL_NAMES.APP_PREPARE]: ['准备应用', 'Prepare an app'],
  [TOOL_NAMES.SKILL_MANAGE]: ['整理技能', 'Manage skills'],
  [TOOL_NAMES.MANAGE_GOAL]: ['更新目标', 'Update the goal'],
  [TOOL_NAMES.SAVE_AGENT]: ['保存专家', 'Save an expert'],
  [TOOL_NAMES.SAVE_TEAM]: ['保存专家团', 'Save an expert team'],
  [TOOL_NAMES.TEST_SKILL_TRIGGER]: ['测试技能是否会被用到', 'Test when a skill is used'],
  [TOOL_NAMES.IMPROVE_SKILL_DESCRIPTION]: ['优化技能说明', 'Improve a skill description'],
  [TOOL_NAMES.UPDATE_SOUL]: ['更新人设', 'Update the persona'],
  [TOOL_NAMES.MANAGE_TRIGGER]: ['管理自动触发', 'Manage automatic triggers'],
  [TOOL_NAMES.MANAGE_FILE_WATCH]: ['管理文件监听', 'Manage file watching'],
  [TOOL_NAMES.MANAGE_MCP_SERVER]: ['管理工具服务', 'Manage tool services'],
  [TOOL_NAMES.COMPUTER]: ['操作电脑', 'Use the computer'],
  [TOOL_NAMES.LOG_TASK_COMPLETION]: ['记录完成情况', 'Record the result'],
  [TOOL_NAMES.CAPABILITY_SNAPSHOT]: ['查看可用能力', 'Check available abilities'],
  [TOOL_NAMES.RUN_AGENT_BATCH]: ['分配给多位专家', 'Assign to several experts'],
};

/** A tool whose step title needs nothing but its name, so a saved title can always be rebuilt. */
export function hasNameOnlyLabel(toolName: string): boolean {
  return toolName in PLAIN_STEP_LABELS;
}

/** What a tool call recorded while it ran (`ToolCall` fields), for labels its input cannot give. */
export interface ToolLabelRecord {
  backgroundCommand?: BackgroundCommandRef;
}

/** File names listed in a present_files input, in order. */
export function presentedFileNames(toolInput: Record<string, unknown>): string[] {
  if (!Array.isArray(toolInput.files)) return [];
  const names: string[] = [];
  for (const entry of toolInput.files as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const path = (entry as Record<string, unknown>).path;
    if (typeof path === 'string' && path.trim()) names.push(getFileName(path.trim()));
  }
  return names;
}

/**
 * Produce the display label (and optional detail) for a tool call in the given
 * locale. Locale defaults to 'zh' only as a defensive fallback — callers should
 * always pass the current UI locale (getLocale() / useI18n().locale).
 */
export function getToolLabel(
  toolName: string,
  toolInput: Record<string, unknown>,
  locale: string = 'zh',
  record?: ToolLabelRecord,
): { label: string; detail?: string } {
  const isZh = locale.startsWith('zh');
  const path = (toolInput.path || toolInput.file_path || toolInput.filePath) as string | undefined;
  const fileName = path ? getFileName(path) : undefined;

  // Handle MCP tools
  const mcpParts = parseMCPToolName(toolName);
  if (mcpParts) {
    const { serverName, actualToolName } = mcpParts;
    const task = dictionary(isZh).task;
    return {
      // Who is doing the work, in words: the built-in browser has a plain name, any other
      // connector is named as the person named it. The tool's own id stays in the details.
      label: BROWSER_SERVERS.has(serverName) ? task.connectorBrowser : format(task.connectorStep, { server: serverName }),
      detail: `${actualToolName} ${JSON.stringify(toolInput)}`,
    };
  }

  switch (toolName) {
    case TOOL_NAMES.EDIT_IMAGE:
      return { label: dictionary(isZh).media.editImage };
    case TOOL_NAMES.READ_FILE:
    case 'read':
    case 'get_file_contents':
      return {
        label: isZh ? (fileName ? `读取 ${fileName}` : '读取文件') : (fileName ? `Read ${fileName}` : 'Read file'),
        detail: path,
      };

    case TOOL_NAMES.WRITE_FILE:
    case 'write':
      return {
        label: isZh ? (fileName ? `写入 ${fileName}` : '写入文件') : (fileName ? `Write ${fileName}` : 'Write file'),
        detail: path,
      };

    case TOOL_NAMES.EDIT_FILE:
    case 'edit':
      return {
        label: isZh ? (fileName ? `修改 ${fileName}` : '修改文件') : (fileName ? `Edit ${fileName}` : 'Edit file'),
        detail: path,
      };

    case 'create_file':
    case 'create':
      return {
        label: isZh ? (fileName ? `创建 ${fileName}` : '创建文件') : (fileName ? `Create ${fileName}` : 'Create file'),
        detail: path,
      };

    case 'bash':
    case TOOL_NAMES.RUN_COMMAND:
    case 'execute':
    case 'shell': {
      // A person who knows nothing about code reads this line, so it says what the step is for
      // (the call's `purpose`), never the command. The command stays in `detail` and in the
      // opened step. A call with no usable purpose (an older conversation, a model that left
      // it out) reads as a generic sentence.
      const cmd = (toolInput.command || toolInput.cmd) as string | undefined;
      const purpose = commandPurpose(toolInput);
      const task = dictionary(isZh).task;
      if (toolName === TOOL_NAMES.RUN_COMMAND && toolInput.background === true) {
        return {
          label: purpose ? format(task.runInBackground, { command: purpose }) : task.commandFallbackBackground,
          detail: cmd,
        };
      }
      return { label: purpose ?? task.commandFallback, detail: cmd };
    }

    case TOOL_NAMES.BACKGROUND_COMMAND_OUTPUT:
    case TOOL_NAMES.STOP_BACKGROUND_COMMAND: {
      // The input names the command by id only; the call records the command text.
      const command = record?.backgroundCommand?.command
        ?? (typeof toolInput.id === 'string' ? toolInput.id : '');
      const task = dictionary(isZh).task;
      const template = toolName === TOOL_NAMES.BACKGROUND_COMMAND_OUTPUT
        ? task.readBackgroundCommandOutput
        : task.stopBackgroundCommand;
      return {
        label: format(template, { command: command ? shortCommand(command) : '' }).trim(),
        detail: command || undefined,
      };
    }

    case 'search':
    case 'grep':
    case 'find':
    case TOOL_NAMES.SEARCH_FILES: {
      const query = (toolInput.query || toolInput.pattern) as string | undefined;
      const shortQuery = query ? (query.length > 15 ? query.slice(0, 15) + '...' : query) : undefined;
      return {
        label: isZh ? (shortQuery ? `搜索 "${shortQuery}"` : '搜索') : (shortQuery ? `Search "${shortQuery}"` : 'Search'),
        detail: query,
      };
    }

    case TOOL_NAMES.FIND_FILES: {
      const filePattern = toolInput.pattern as string | undefined;
      const shortPattern = filePattern ? (filePattern.length > 15 ? filePattern.slice(0, 15) + '...' : filePattern) : undefined;
      return {
        label: isZh ? (shortPattern ? `查找 ${shortPattern}` : '查找文件') : (shortPattern ? `Find ${shortPattern}` : 'Find files'),
        detail: filePattern,
      };
    }

    case TOOL_NAMES.WEB_SEARCH: {
      const query = toolInput.query as string | undefined;
      const shortQuery = query ? (query.length > 15 ? query.slice(0, 15) + '...' : query) : undefined;
      return {
        label: isZh ? (shortQuery ? `网页搜索 "${shortQuery}"` : '网页搜索') : (shortQuery ? `Web search "${shortQuery}"` : 'Web search'),
        detail: query,
      };
    }

    case TOOL_NAMES.HTTP_FETCH: {
      const url = toolInput.url;
      const template = dictionary(isZh).task.fetchPage;
      if (typeof url === 'string') {
        return { label: format(template, { url: shortUrl(url) }), detail: url };
      }
      return { label: format(template, { url: '' }).trim() };
    }

    case TOOL_NAMES.USE_SKILL: {
      const skillName = (toolInput.skill_name as string | undefined)?.replace(/^\/+/, '');
      return {
        label: isZh ? (skillName ? `使用 /${skillName} 技能` : '使用技能') : (skillName ? `Use /${skillName} skill` : 'Use skill'),
        detail: toolInput.context as string | undefined,
      };
    }

    case TOOL_NAMES.DELEGATE_TO_AGENT: {
      const agentName = toolInput.agent_name as string | undefined;
      return {
        label: isZh
          ? (agentName ? `委派给 ${agentName}` : '委派任务')
          : (agentName ? `Delegate to ${agentName}` : 'Delegate task'),
        detail: toolInput.task as string | undefined,
      };
    }

    case TOOL_NAMES.MANAGE_SCHEDULED_TASK: {
      const action = toolInput.action as string | undefined;
      const taskName = toolInput.name as string | undefined;
      const labels: Record<string, string> = {
        create: isZh ? '创建定时任务' : 'Create scheduled task',
        list: isZh ? '查看定时任务' : 'List scheduled tasks',
        update: isZh ? '更新定时任务' : 'Update scheduled task',
        delete: isZh ? '删除定时任务' : 'Delete scheduled task',
        pause: isZh ? '暂停定时任务' : 'Pause scheduled task',
        resume: isZh ? '恢复定时任务' : 'Resume scheduled task',
      };
      const label = (action && labels[action]) || (isZh ? '管理定时任务' : 'Manage scheduled task');
      return { label: taskName ? `${label}「${taskName}」` : label };
    }

    case TOOL_NAMES.GET_SYSTEM_INFO:
      return {
        label: isZh ? '获取系统信息' : 'Get system info',
      };

    case TOOL_NAMES.DELETE_FILE:
      return {
        label: isZh ? (fileName ? `删除 ${fileName}` : '删除文件') : (fileName ? `Delete ${fileName}` : 'Delete file'),
        detail: path,
      };

    // show_widget is hidden from the chat's generic tool list (rendered as
    // ShowWidgetCard instead — see MessageGroup.tsx), but its execution step
    // still surfaces in the right-side progress panel, which uses this label.
    case TOOL_NAMES.SHOW_WIDGET: {
      const widgetTitle = typeof toolInput.title === 'string' ? toolInput.title : undefined;
      const base = isZh ? '渲染可视化组件' : 'Render widget';
      return { label: widgetTitle ? `${base}「${widgetTitle}」` : base };
    }

    case TOOL_NAMES.READ_ME:
      return {
        label: isZh ? '加载可视化设计指南' : 'Load widget guidelines',
      };

    case TOOL_NAMES.LIST_DIRECTORY: {
      const dirPath = path || (toolInput.directory as string);
      const dirName = dirPath ? getFileName(dirPath) : undefined;
      return {
        label: isZh ? (dirName ? `列出 ${dirName}` : '列出目录') : (dirName ? `List ${dirName}` : 'List directory'),
        detail: dirPath,
      };
    }

    case TOOL_NAMES.PRESENT_FILES: {
      const names = presentedFileNames(toolInput);
      return {
        label: isZh
          ? `交付了 ${names.length} 个文件`
          : `Presented ${names.length} ${names.length === 1 ? 'file' : 'files'}`,
        detail: names.length > 0 ? names.join(isZh ? '、' : ', ') : undefined,
      };
    }

    case MEMBER_INSTRUCTION_STEP:
      return {
        label: isZh ? '你的追加指令' : 'Your instruction',
        detail: typeof toolInput.text === 'string' ? toolInput.text : undefined,
      };

    default: {
      // Steps people meet in an ordinary conversation are named in their words. Never the
      // tool's own id: it means nothing to the person.
      const plain = PLAIN_STEP_LABELS[toolName];
      return { label: plain ? (isZh ? plain[0] : plain[1]) : dictionary(isZh).task.toolFallback };
    }
  }
}

/**
 * Semantic key for a detail block's collapsible header label. Stored on the
 * block (language-neutral) so the header can be localized at render time.
 */
export type DetailBlockLabelKey = 'result' | 'error' | 'script' | 'content' | 'summary' | 'image';

/** Localize a detail block header label at render time. */
export function getDetailBlockLabel(labelKey: DetailBlockLabelKey, locale: string): string {
  const isZh = locale.startsWith('zh');
  switch (labelKey) {
    case 'result':
      return isZh ? '结果' : 'Result';
    case 'error':
      return isZh ? '错误' : 'Error';
    case 'script':
      return isZh ? '脚本' : 'Script';
    case 'content':
      return isZh ? '内容' : 'Content';
    case 'summary':
      return isZh ? '执行摘要' : 'Result Summary';
    case 'image':
      return isZh ? '图片' : 'Image';
  }
}
