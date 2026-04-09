/**
 * MCP Discovery — search and install MCP servers on demand
 *
 * Maintains a built-in registry of common MCP servers.
 * Agent can search the registry when it discovers capability gaps,
 * and install servers with user confirmation.
 */

import { resolveResource } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import { useMCPStore } from '../../stores/mcpStore';

export interface MCPRegistryEntry {
  name: string;
  description: string;
  keywords: string[];
  command: string;
  args: string[];
  env: Record<string, string>;
  envHints?: Record<string, string>; // hints for env vars the user needs to provide
  /** Path to a bundled resource directory associated with this server */
  bundledResourceDir?: string;
}

/**
 * Built-in MCP server registry.
 * Covers common use cases. Agent can fall back to web_search for unlisted servers.
 */
const BUILTIN_REGISTRY: MCPRegistryEntry[] = [
  {
    name: 'github',
    description: 'GitHub 仓库管理：PR、Issue、代码搜索、仓库操作',
    keywords: ['github', 'pr', 'pull request', 'issue', 'repository', 'repo', 'code review', 'git'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    envHints: { GITHUB_PERSONAL_ACCESS_TOKEN: '需要 GitHub Personal Access Token (Settings → Developer settings → Tokens)' },
  },
  {
    name: 'filesystem',
    description: '文件系统操作：读写文件、目录遍历、文件搜索',
    keywords: ['file', 'filesystem', 'directory', 'folder', 'read', 'write'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: {},
  },
  {
    name: 'slack',
    description: 'Slack 消息：发送消息、读取频道、管理频道',
    keywords: ['slack', 'message', 'channel', 'chat', 'team'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' },
    envHints: { SLACK_BOT_TOKEN: 'Slack Bot Token (api.slack.com → Your Apps)', SLACK_TEAM_ID: 'Slack Team ID' },
  },
  {
    name: 'notion',
    description: 'Notion 页面管理：创建、编辑、搜索页面和数据库',
    keywords: ['notion', 'page', 'database', 'wiki', 'document', 'note'],
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: { OPENAPI_MCP_HEADERS: '' },
    envHints: { OPENAPI_MCP_HEADERS: '格式: {"Authorization": "Bearer ntn_xxx", "Notion-Version": "2022-06-28"}' },
  },
  {
    name: 'postgres',
    description: 'PostgreSQL 数据库：查询、表结构、数据操作',
    keywords: ['postgres', 'postgresql', 'database', 'sql', 'db', 'query'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    env: { DATABASE_URL: '' },
    envHints: { DATABASE_URL: 'PostgreSQL 连接字符串，如 postgresql://user:pass@host:5432/dbname' },
  },
  {
    name: 'sqlite',
    description: 'SQLite 数据库：查询、表管理',
    keywords: ['sqlite', 'database', 'sql', 'db', 'query'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
    env: {},
  },
  {
    name: 'google-maps',
    description: 'Google 地图：地点搜索、路线规划、地理编码',
    keywords: ['map', 'maps', 'google maps', 'location', 'route', 'geocode', 'place'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    env: { GOOGLE_MAPS_API_KEY: '' },
    envHints: { GOOGLE_MAPS_API_KEY: 'Google Maps API Key (console.cloud.google.com)' },
  },
  {
    name: 'brave-search',
    description: '网络搜索：通过 Brave Search API 搜索互联网',
    keywords: ['search', 'web', 'internet', 'browse', 'brave'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '' },
    envHints: { BRAVE_API_KEY: 'Brave Search API Key (brave.com/search/api)' },
  },
  {
    name: 'puppeteer',
    description: '浏览器自动化：网页截图、页面操作、数据抓取',
    keywords: ['browser', 'puppeteer', 'screenshot', 'scrape', 'web', 'crawl', 'automation'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    env: {},
  },
  {
    name: 'memory',
    description: '知识图谱记忆：存储和查询实体关系',
    keywords: ['memory', 'knowledge', 'graph', 'entity', 'relation'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
  },
  {
    name: 'sequential-thinking',
    description: '结构化思考：多步推理、问题分解、决策分析',
    keywords: ['thinking', 'reasoning', 'analysis', 'decision', 'step-by-step'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: {},
  },
  {
    name: 'fetch',
    description: '网页获取：抓取和转换网页内容为 Markdown',
    keywords: ['fetch', 'http', 'url', 'webpage', 'download', 'markdown'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    env: {},
  },
  {
    name: 'abu-browser-bridge',
    description: '浏览器桥接：操作用户真实的 Chrome 浏览器，点击、填写、截图、提取数据',
    keywords: ['browser', 'chrome', 'click', 'fill', 'screenshot', 'scrape', 'web', 'automation', 'tab'],
    command: 'npx',
    args: ['-y', 'abu-browser-bridge@latest'],
    env: {},
    bundledResourceDir: 'browser-extension',
  },
];

/**
 * Search the built-in MCP registry by keyword.
 * Returns matching entries sorted by relevance.
 */
export function searchMCPRegistry(query: string): MCPRegistryEntry[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);

  // Check which servers are already configured
  const configuredNames = new Set(
    Object.keys(useMCPStore.getState().servers)
  );

  const scored = BUILTIN_REGISTRY
    .filter((entry) => !configuredNames.has(entry.name))
    .map((entry) => {
      let score = 0;
      for (const term of terms) {
        if (entry.name.includes(term)) score += 10;
        if (entry.description.toLowerCase().includes(term)) score += 5;
        if (entry.keywords.some((k) => k.includes(term))) score += 8;
      }
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map(({ entry }) => entry);
}

/**
 * Install an MCP server by adding it to the store and connecting.
 */
export async function installMCPServer(
  registryEntry: MCPRegistryEntry,
  userEnv?: Record<string, string>
): Promise<{ success: boolean; message: string; toolCount?: number }> {
  const store = useMCPStore.getState();

  // Check if already configured
  if (store.servers[registryEntry.name]) {
    const entry = store.servers[registryEntry.name];
    if (entry.status === 'connected') {
      return { success: true, message: `${registryEntry.name} 已连接，有 ${entry.tools.length} 个工具可用。`, toolCount: entry.tools.length };
    }
    // Try reconnecting
    await store.connectServer(registryEntry.name);
    const updated = useMCPStore.getState().servers[registryEntry.name];
    if (updated?.status === 'connected') {
      return { success: true, message: `${registryEntry.name} 重新连接成功，有 ${updated.tools.length} 个工具。`, toolCount: updated.tools.length };
    }
    return { success: false, message: `${registryEntry.name} 连接失败: ${updated?.error ?? '未知错误'}` };
  }

  // Merge env vars
  const finalEnv = { ...registryEntry.env, ...userEnv };

  // Check required env vars
  const missingEnv = Object.entries(finalEnv)
    .filter(([, v]) => v === '')
    .map(([k]) => k);

  if (missingEnv.length > 0) {
    const hints = missingEnv.map((k) => {
      const hint = registryEntry.envHints?.[k];
      return hint ? `  - ${k}: ${hint}` : `  - ${k}`;
    });
    return {
      success: false,
      message: `安装 ${registryEntry.name} 需要以下环境变量:\n${hints.join('\n')}\n\n请让用户提供这些值后重试。`,
    };
  }

  // Add and connect
  store.addServer({
    name: registryEntry.name,
    transport: 'stdio',
    command: registryEntry.command,
    args: registryEntry.args,
    env: finalEnv,
    enabled: true,
  });

  await store.connectServer(registryEntry.name);
  const result = useMCPStore.getState().servers[registryEntry.name];

  if (result?.status === 'connected') {
    return {
      success: true,
      message: `${registryEntry.name} 安装并连接成功，发现 ${result.tools.length} 个工具。`,
      toolCount: result.tools.length,
    };
  }

  return {
    success: false,
    message: `${registryEntry.name} 安装后连接失败: ${result?.error ?? '未知错误'}。请检查命令和环境变量配置。`,
  };
}

/**
 * Find a registry entry by exact name.
 */
export function getRegistryEntry(name: string): MCPRegistryEntry | undefined {
  return BUILTIN_REGISTRY.find((e) => e.name === name);
}

/**
 * Resolve the absolute path to a bundled resource directory.
 * Returns null if the resource doesn't exist (e.g. dev mode without build).
 */
async function resolveBundledResource(dirName: string): Promise<string | null> {
  // Production: Tauri resolveResource
  try {
    const resolved = await resolveResource(dirName);
    if (resolved && await exists(resolved)) return resolved;
  } catch { /* dev mode fallback */ }

  // Dev mode: try relative paths from Tauri CWD (src-tauri/)
  const { resolve } = await import('@tauri-apps/api/path');
  for (const candidate of [`../${dirName}`, dirName]) {
    try {
      const p = await resolve(candidate);
      if (p && await exists(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

export interface EnsureResult {
  status: 'connected' | 'reconnected' | 'installed' | 'needs_config' | 'failed';
  message: string;
  toolCount?: number;
  /** Absolute path to a bundled companion resource (e.g. Chrome extension dir) */
  extensionPath?: string | null;
}

/**
 * Ensure an MCP server is installed and connected.
 * Unlike install, this is idempotent and does not require user confirmation.
 * - Already connected → returns immediately
 * - Configured but disconnected → reconnects
 * - Not configured → auto-installs from registry (if no env vars required)
 */
export async function ensureMCPServer(name: string): Promise<EnsureResult> {
  const store = useMCPStore.getState();
  const entry = getRegistryEntry(name);

  // Resolve companion resource path if applicable
  const extensionPath = entry?.bundledResourceDir
    ? await resolveBundledResource(entry.bundledResourceDir)
    : null;

  // Case 1: already configured
  if (store.servers[name]) {
    const server = store.servers[name];
    if (server.status === 'connected') {
      return {
        status: 'connected',
        message: `${name} 已连接，有 ${server.tools.length} 个工具可用。`,
        toolCount: server.tools.length,
        extensionPath,
      };
    }
    // Try reconnecting
    await store.connectServer(name);
    const updated = useMCPStore.getState().servers[name];
    if (updated?.status === 'connected') {
      return {
        status: 'reconnected',
        message: `${name} 重新连接成功，有 ${updated.tools.length} 个工具。`,
        toolCount: updated.tools.length,
        extensionPath,
      };
    }
    return {
      status: 'failed',
      message: `${name} 连接失败: ${updated?.error ?? '未知错误'}`,
      extensionPath,
    };
  }

  // Case 2: not configured — try auto-install from registry
  if (!entry) {
    return {
      status: 'failed',
      message: `未在内置注册表中找到 "${name}"。请用 manage_mcp_server(action: "search") 搜索。`,
    };
  }

  // Check if env vars are needed
  const missingEnv = Object.entries(entry.env).filter(([, v]) => v === '').map(([k]) => k);
  if (missingEnv.length > 0) {
    const hints = missingEnv.map((k) => {
      const hint = entry.envHints?.[k];
      return hint ? `${k}: ${hint}` : k;
    });
    return {
      status: 'needs_config',
      message: `安装 ${name} 需要配置: ${hints.join(', ')}`,
      extensionPath,
    };
  }

  // Auto-install: no env vars needed, proceed without confirmation
  const result = await installMCPServer(entry);
  return {
    status: result.success ? 'installed' : 'failed',
    message: result.message,
    toolCount: result.toolCount,
    extensionPath,
  };
}
