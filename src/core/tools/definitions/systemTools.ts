import { readText as clipboardReadText, writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import type { ToolDefinition } from '../../../types';
import { searchMCPRegistry, installMCPServer, getRegistryEntry } from '../../agent/mcpDiscovery';
import { getSystemInfoData } from '../helpers/toolHelpers';

export const getSystemInfoTool: ToolDefinition = {
  name: 'get_system_info',
  description: '获取系统环境信息（主目录、桌面、文档、下载等路径）。首次需要定位文件时使用。返回平台类型和常用目录的绝对路径。',
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

// ============================================================
// Clipboard Tools
// ============================================================

export const clipboardReadTool: ToolDefinition = {
  name: 'clipboard_read',
  description: '读取系统剪贴板中的文本内容。当用户提到"剪贴板"、"粘贴板"、"我复制的内容"时使用。返回剪贴板文本或空提示。',
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

export const clipboardWriteTool: ToolDefinition = {
  name: 'clipboard_write',
  description: '将文本内容写入系统剪贴板。',
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

export const systemNotifyTool: ToolDefinition = {
  name: 'system_notify',
  description: '发送系统桌面通知。当用户要求"完成后通知我"或需要重要提醒时使用。',
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

/**
 * manage_mcp_server — search and install MCP servers
 */
export const manageMCPServerTool: ToolDefinition = {
  name: 'manage_mcp_server',
  description: '搜索和安装 MCP 工具服务。当执行任务时发现缺少某种工具能力（如操作 GitHub、Slack、数据库等）时使用。注意：这不是通用软件安装工具，不要用于安装普通软件。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'install'],
        description: '操作类型：search（搜索可用服务）或 install（安装服务）',
      },
      query: { type: 'string', description: '搜索关键词（action=search 时必填），如 "github"、"slack"、"database"' },
      name: { type: 'string', description: 'MCP Server 名称（action=install 时必填，来自 search 结果）' },
      env: {
        type: 'object',
        description: '环境变量键值对（action=install 时可选，如 API Key 等）',
      },
    },
    required: ['action'],
  },
  execute: async (input) => {
    const action = input.action as string;

    if (action === 'search') {
      const query = input.query as string;
      if (!query) return 'Error: action=search 时必须提供 query 参数';
      const results = searchMCPRegistry(query);
      if (results.length === 0) {
        return `未找到匹配 "${query}" 的 MCP Server。你可以用 web_search 搜索 "${query} MCP server" 寻找社区方案。`;
      }
      const lines = results.map((r) => {
        const envNeeded = Object.keys(r.env).filter((k) => r.envHints?.[k]);
        const envNote = envNeeded.length > 0 ? ` (需要: ${envNeeded.join(', ')})` : '';
        return `- **${r.name}**: ${r.description}${envNote}`;
      });
      return `找到 ${results.length} 个可用的 MCP Server:\n${lines.join('\n')}\n\n使用 manage_mcp_server(action: "install", name: "...") 安装。安装前请告知用户并获得确认。`;
    }

    if (action === 'install') {
      const name = input.name as string;
      if (!name) return 'Error: action=install 时必须提供 name 参数';
      const env = input.env as Record<string, string> | undefined;

      const entry = getRegistryEntry(name);
      if (!entry) {
        return `未找到名为 "${name}" 的 MCP Server。请先用 manage_mcp_server(action: "search") 搜索。`;
      }

      try {
        const result = await installMCPServer(entry, env);
        return result.message;
      } catch (err) {
        return `安装失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return `Error: 未知操作 "${action}"。可用操作: search, install`;
  },
};
