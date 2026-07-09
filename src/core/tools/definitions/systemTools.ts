import { readText as clipboardReadText, writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import type { ToolDefinition } from '../../../types';
import { searchMCPRegistry, installMCPServer, getRegistryEntry, ensureMCPServer, addCustomMCPServer } from '../../agent/mcpDiscovery';
import { getSystemInfoData } from '../helpers/toolHelpers';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';

export const getSystemInfoTool: ToolDefinition = {
  name: TOOL_NAMES.GET_SYSTEM_INFO,
  description: 'Get system environment information (home directory, desktop, documents, downloads, and other paths). Use when you first need to locate files. Returns the platform type and absolute paths to common directories.',
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
  isConcurrencySafe: true,
};

// ============================================================
// Clipboard Tools
// ============================================================

export const clipboardReadTool: ToolDefinition = {
  name: TOOL_NAMES.CLIPBOARD_READ,
  description: 'Read the text content from the system clipboard. Use when the user mentions "clipboard", "what I copied", or similar. Returns the clipboard text or an empty indicator.',
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
  isConcurrencySafe: true,
};

export const clipboardWriteTool: ToolDefinition = {
  name: TOOL_NAMES.CLIPBOARD_WRITE,
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
  isConcurrencySafe: false,
};

// ============================================================
// System Notification Tool
// ============================================================

export const systemNotifyTool: ToolDefinition = {
  name: TOOL_NAMES.SYSTEM_NOTIFY,
  description: 'Send a system desktop notification. Use when the user asks to "notify me when done" or when an important reminder is needed.',
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
  isConcurrencySafe: true,
};

/**
 * manage_mcp_server — search and install MCP servers
 */
export const manageMCPServerTool: ToolDefinition = {
  name: TOOL_NAMES.MANAGE_MCP_SERVER,
  description: 'Search for, install, or ensure an MCP tool server is available; can also add a private/internal MCP service directly by URL. Use when a task requires a tool capability that is missing (e.g. operating GitHub, Slack, databases, browsers, etc.). Note: this is not a general-purpose software installer — do not use it to install ordinary software.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'install', 'ensure', 'add_custom'],
        description: 'Operation type: search (search available servers), install (install a server, requires user confirmation), ensure (ensure a server is available, installs automatically without confirmation), add_custom (add a custom server by URL, no registry needed)',
      },
      query: { type: 'string', description: 'Search keywords (required when action=search), e.g. "github", "slack", "database"' },
      name: { type: 'string', description: 'MCP server name (required when action=install/ensure/add_custom)' },
      env: {
        type: 'object',
        description: 'Environment variable key-value pairs (optional when action=install, e.g. API keys)',
      },
      url: { type: 'string', description: 'MCP service URL (required when action=add_custom), e.g. "http://10.0.0.1:8080/mcp"' },
      headers: {
        type: 'object',
        description: 'HTTP request headers (optional when action=add_custom), e.g. {"Authorization": "Bearer token"}',
      },
    },
    required: ['action'],
  },
  execute: async (input) => {
    const action = input.action as string;
    const t = getI18n().toolResult.system;

    if (action === 'search') {
      const query = input.query as string;
      if (!query) return t.errSearchNeedsQuery;
      const results = searchMCPRegistry(query);
      if (results.length === 0) {
        return format(t.searchNoResults, { query });
      }
      const lines = results.map((r) => {
        const envNeeded = Object.keys(r.env).filter((k) => r.envHints?.[k]);
        const envNote = envNeeded.length > 0 ? format(t.searchEnvNote, { envList: envNeeded.join(', ') }) : '';
        return `- **${r.name}**: ${r.description}${envNote}`;
      });
      return format(t.searchResults, { count: String(results.length), lines: lines.join('\n') });
    }

    if (action === 'install') {
      const name = input.name as string;
      if (!name) return t.errInstallNeedsName;
      const env = input.env as Record<string, string> | undefined;

      const entry = getRegistryEntry(name);
      if (!entry) {
        return format(t.errInstallNotFound, { name });
      }

      try {
        const result = await installMCPServer(entry, env);
        return result.message;
      } catch (err) {
        return format(t.installFailed, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (action === 'ensure') {
      const name = input.name as string;
      if (!name) return t.errEnsureNeedsName;

      try {
        const result = await ensureMCPServer(name);
        const parts = [result.message];
        if (result.extensionPath) {
          parts.push(`extensionPath: ${result.extensionPath}`);
        }
        return parts.join('\n');
      } catch (err) {
        return format(t.ensureFailed, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (action === 'add_custom') {
      const name = input.name as string;
      const url = input.url as string;
      if (!name) return t.errAddCustomNeedsName;
      if (!url) return t.errAddCustomNeedsUrl;
      const headers = input.headers as Record<string, string> | undefined;

      try {
        const result = await addCustomMCPServer(name, url, headers);
        return result.message;
      } catch (err) {
        return format(t.addCustomFailed, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    return format(t.errUnknownAction, { action });
  },
  isConcurrencySafe: false,
};
