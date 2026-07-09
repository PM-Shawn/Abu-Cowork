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
import { getI18n, format } from '../../i18n';

export interface MCPRegistryEntry {
  name: string;
  keywords: string[];
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Path to a bundled resource directory associated with this server */
  bundledResourceDir?: string;
}

/**
 * Built-in MCP server registry.
 * Covers common use cases. Agent can fall back to web_search for unlisted servers.
 *
 * User-visible descriptions and env-var hints are NOT stored here — they are
 * localized and resolved on demand from the `toolResult.system` i18n namespace
 * (`mcpCatalog` keyed by server name, `mcpEnvHints` keyed by env-var name). See
 * getEntryDescription() / getEnvHint() below.
 */
const BUILTIN_REGISTRY: MCPRegistryEntry[] = [
  {
    name: 'github',
    keywords: ['github', 'pr', 'pull request', 'issue', 'repository', 'repo', 'code review', 'git'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
  },
  {
    name: 'filesystem',
    keywords: ['file', 'filesystem', 'directory', 'folder', 'read', 'write'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: {},
  },
  {
    name: 'slack',
    keywords: ['slack', 'message', 'channel', 'chat', 'team'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' },
  },
  {
    name: 'notion',
    keywords: ['notion', 'page', 'database', 'wiki', 'document', 'note'],
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: { OPENAPI_MCP_HEADERS: '' },
  },
  {
    name: 'postgres',
    keywords: ['postgres', 'postgresql', 'database', 'sql', 'db', 'query'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    env: { DATABASE_URL: '' },
  },
  {
    name: 'sqlite',
    keywords: ['sqlite', 'database', 'sql', 'db', 'query'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
    env: {},
  },
  {
    name: 'google-maps',
    keywords: ['map', 'maps', 'google maps', 'location', 'route', 'geocode', 'place'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    env: { GOOGLE_MAPS_API_KEY: '' },
  },
  {
    name: 'brave-search',
    keywords: ['search', 'web', 'internet', 'browse', 'brave'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '' },
  },
  {
    name: 'puppeteer',
    keywords: ['browser', 'puppeteer', 'screenshot', 'scrape', 'web', 'crawl', 'automation'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    env: {},
  },
  {
    name: 'memory',
    keywords: ['memory', 'knowledge', 'graph', 'entity', 'relation'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
  },
  {
    name: 'sequential-thinking',
    keywords: ['thinking', 'reasoning', 'analysis', 'decision', 'step-by-step'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: {},
  },
  {
    name: 'fetch',
    keywords: ['fetch', 'http', 'url', 'webpage', 'download', 'markdown'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    env: {},
  },
  {
    name: 'abu-browser-bridge',
    keywords: ['browser', 'chrome', 'click', 'fill', 'screenshot', 'scrape', 'web', 'automation', 'tab'],
    command: 'npx',
    args: ['-y', 'abu-browser-bridge@latest'],
    env: {},
    bundledResourceDir: 'browser-extension',
  },
];

/**
 * Localized, user-visible description for a registry server, resolved from the
 * current UI locale. Falls back to the server name if no catalog entry exists.
 */
export function getEntryDescription(name: string): string {
  return getI18n().toolResult.system.mcpCatalog[name] ?? name;
}

/**
 * Localized config hint for an env var (e.g. how to obtain an API token).
 * Returns undefined when the env var has no hint.
 */
export function getEnvHint(envKey: string): string | undefined {
  return getI18n().toolResult.system.mcpEnvHints[envKey];
}

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
        if (getEntryDescription(entry.name).toLowerCase().includes(term)) score += 5;
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
  const t = getI18n().toolResult.system;

  // Check if already configured
  if (store.servers[registryEntry.name]) {
    const entry = store.servers[registryEntry.name];
    if (entry.status === 'connected') {
      return { success: true, message: format(t.mcpConnected, { name: registryEntry.name, count: entry.tools.length }), toolCount: entry.tools.length };
    }
    // Try reconnecting
    await store.connectServer(registryEntry.name);
    const updated = useMCPStore.getState().servers[registryEntry.name];
    if (updated?.status === 'connected') {
      return { success: true, message: format(t.mcpReconnected, { name: registryEntry.name, count: updated.tools.length }), toolCount: updated.tools.length };
    }
    return { success: false, message: format(t.mcpConnectFailed, { name: registryEntry.name, error: updated?.error ?? t.mcpUnknownError }) };
  }

  // Merge env vars
  const finalEnv = { ...registryEntry.env, ...userEnv };

  // Check required env vars
  const missingEnv = Object.entries(finalEnv)
    .filter(([, v]) => v === '')
    .map(([k]) => k);

  if (missingEnv.length > 0) {
    const hints = missingEnv.map((k) => {
      const hint = getEnvHint(k);
      return hint ? `  - ${k}: ${hint}` : `  - ${k}`;
    });
    return {
      success: false,
      message: format(t.mcpNeedsEnvVars, { name: registryEntry.name, hints: hints.join('\n') }),
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
      message: format(t.mcpInstalledConnected, { name: registryEntry.name, count: result.tools.length }),
      toolCount: result.tools.length,
    };
  }

  return {
    success: false,
    message: format(t.mcpInstallConnectFailed, { name: registryEntry.name, error: result?.error ?? t.mcpUnknownError }),
  };
}

/**
 * Find a registry entry by exact name.
 */
export function getRegistryEntry(name: string): MCPRegistryEntry | undefined {
  return BUILTIN_REGISTRY.find((e) => e.name === name);
}

/**
 * Add a custom URL-based MCP server that is not in the built-in registry.
 * Handles already-configured servers by reconnecting instead of duplicating.
 */
export async function addCustomMCPServer(
  name: string,
  url: string,
  headers?: Record<string, string>
): Promise<{ success: boolean; message: string; toolCount?: number }> {
  const t = getI18n().toolResult.system;

  if (!name || !url) {
    return { success: false, message: t.mcpNameUrlRequired };
  }

  try {
    new URL(url);
  } catch {
    return { success: false, message: format(t.mcpInvalidUrl, { url }) };
  }

  const store = useMCPStore.getState();

  if (store.servers[name]) {
    const existing = store.servers[name];
    if (existing.status === 'connected') {
      return {
        success: true,
        message: format(t.mcpConnected, { name, count: existing.tools.length }),
        toolCount: existing.tools.length,
      };
    }
    await store.connectServer(name);
    const updated = useMCPStore.getState().servers[name];
    if (updated?.status === 'connected') {
      return {
        success: true,
        message: format(t.mcpReconnected, { name, count: updated.tools.length }),
        toolCount: updated.tools.length,
      };
    }
    return {
      success: false,
      message: format(t.mcpConnectFailed, { name, error: updated?.error ?? t.mcpUnknownError }),
    };
  }

  store.addServer({
    name,
    url,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    enabled: true,
  });

  await store.connectServer(name);
  const result = useMCPStore.getState().servers[name];

  if (result?.status === 'connected') {
    const toolList = result.tools.length > 0
      ? format(t.mcpAddedToolList, { tools: result.tools.map((tool) => tool.name).join(', ') })
      : '';
    return {
      success: true,
      message: format(t.mcpAddedConnected, { name, count: result.tools.length, toolList }),
      toolCount: result.tools.length,
    };
  }

  return {
    success: false,
    message: format(t.mcpAddConnectFailed, { name, error: result?.error ?? t.mcpUnknownError }),
  };
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
  const t = getI18n().toolResult.system;
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
        message: format(t.mcpConnected, { name, count: server.tools.length }),
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
        message: format(t.mcpReconnected, { name, count: updated.tools.length }),
        toolCount: updated.tools.length,
        extensionPath,
      };
    }
    return {
      status: 'failed',
      message: format(t.mcpConnectFailed, { name, error: updated?.error ?? t.mcpUnknownError }),
      extensionPath,
    };
  }

  // Case 2: not configured — try auto-install from registry
  if (!entry) {
    return {
      status: 'failed',
      message: format(t.mcpNotInRegistry, { name }),
    };
  }

  // Check if env vars are needed
  const missingEnv = Object.entries(entry.env).filter(([, v]) => v === '').map(([k]) => k);
  if (missingEnv.length > 0) {
    const hints = missingEnv.map((k) => {
      const hint = getEnvHint(k);
      return hint ? `${k}: ${hint}` : k;
    });
    return {
      status: 'needs_config',
      message: format(t.mcpNeedsConfig, { name, hints: hints.join(', ') }),
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
