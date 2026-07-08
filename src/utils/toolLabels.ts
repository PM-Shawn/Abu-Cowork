import { TOOL_NAMES } from '@/core/tools/toolNames';

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

function getFileName(path: string): string {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

/**
 * Produce the display label (and optional detail) for a tool call in the given
 * locale. Locale defaults to 'zh' only as a defensive fallback — callers should
 * always pass the current UI locale (getLocale() / useI18n().locale).
 */
export function getToolLabel(
  toolName: string,
  toolInput: Record<string, unknown>,
  locale: string = 'zh'
): { label: string; detail?: string } {
  const isZh = locale.startsWith('zh');
  const path = (toolInput.path || toolInput.file_path || toolInput.filePath) as string | undefined;
  const fileName = path ? getFileName(path) : undefined;

  // Handle MCP tools
  const mcpParts = parseMCPToolName(toolName);
  if (mcpParts) {
    const { serverName, actualToolName } = mcpParts;
    return {
      label: `[${serverName}] ${actualToolName}`,
      detail: JSON.stringify(toolInput),
    };
  }

  switch (toolName) {
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
      const cmd = (toolInput.command || toolInput.cmd) as string | undefined;
      const shortCmd = cmd ? (cmd.length > 20 ? cmd.slice(0, 20) + '...' : cmd) : undefined;
      return {
        label: isZh ? (shortCmd ? `执行 ${shortCmd}` : '执行命令') : (shortCmd ? `Run ${shortCmd}` : 'Run command'),
        detail: cmd,
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

    case TOOL_NAMES.LIST_DIRECTORY: {
      const dirPath = path || (toolInput.directory as string);
      const dirName = dirPath ? getFileName(dirPath) : undefined;
      return {
        label: isZh ? (dirName ? `列出 ${dirName}` : '列出目录') : (dirName ? `List ${dirName}` : 'List directory'),
        detail: dirPath,
      };
    }

    default:
      return {
        label: isZh ? `调用 ${toolName}` : `Call ${toolName}`,
      };
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
