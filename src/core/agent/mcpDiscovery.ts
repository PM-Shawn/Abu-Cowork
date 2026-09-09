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
import { hasElectronCommandHost } from '../../utils/electronHost';

export const ELECTRON_CHROME_BRIDGE_COMMAND = 'abu-chrome-bridge-runtime';

export interface MCPRegistryEntry {
  name: string;
  keywords: string[];
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Path to a bundled resource directory associated with this server */
  bundledResourceDir?: string;
  /**
   * Positional arguments the user must supply before the server can start —
   * a connection string, a database path. `index` points into `args`, whose
   * slot holds an empty string until it is filled. The label is localized:
   * `mcpArgLabels[`${name}.${index}`]` (see getArgLabel()).
   */
  configurableArgs?: { index: number; placeholder: string }[];
  /**
   * Example shape of a secret, shown as the field's placeholder (`ghp_...`).
   * These are token formats, not prose, so they are not localized. A key with
   * no entry shows an empty placeholder.
   */
  envPlaceholders?: Record<string, string>;
  /** Tool-call timeout in ms for this server. Omitted means the store default. */
  defaultTimeout?: number;
}

/**
 * Built-in MCP server registry.
 * Covers common use cases. Agent can fall back to web_search for unlisted servers.
 *
 * User-visible prose is NOT stored here — it is localized and resolved on
 * demand from the `toolResult.system` i18n namespace: `mcpCatalog` keyed by
 * server name, `mcpEnvHints` keyed by env-var name, `mcpArgLabels` keyed by
 * `${name}.${argIndex}`, `mcpSetupHints` keyed by server name. See
 * getEntryDescription() / getEnvHint() / getArgLabel() / getSetupHint() below.
 * Token-shape placeholders (`ghp_...`) are not prose and stay in the data.
 *
 * Exported so the Connectors 「市场」 can list the same catalog the agent
 * searches — one registry, not a second hand-kept copy that drifts from it.
 * Consumers that need the entry as this host would run it must resolve it
 * through getRegistryEntry(); the raw array is unresolved by design.
 */
export const BUILTIN_REGISTRY: MCPRegistryEntry[] = [
  {
    name: 'github',
    keywords: ['github', 'pr', 'pull request', 'issue', 'repository', 'repo', 'code review', 'git'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    envPlaceholders: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_...' },
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
    // The package's own README configures it with NOTION_TOKEN; the older
    // OPENAPI_MCP_HEADERS JSON blob is a second, undocumented path.
    env: { NOTION_TOKEN: '' },
    envPlaceholders: { NOTION_TOKEN: 'ntn_...' },
  },
  {
    name: 'postgres',
    keywords: ['postgres', 'postgresql', 'database', 'sql', 'db', 'query'],
    command: 'npx',
    // The server reads its connection string from argv, not from the
    // environment — DATABASE_URL is silently ignored and it exits.
    args: ['-y', '@modelcontextprotocol/server-postgres', ''],
    env: {},
    configurableArgs: [{ index: 2, placeholder: 'postgresql://user:pass@localhost:5432/db' }],
  },
  {
    name: 'brave-search',
    keywords: ['search', 'web', 'internet', 'browse', 'brave'],
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server'],
    env: { BRAVE_API_KEY: '' },
    envPlaceholders: { BRAVE_API_KEY: 'BSA...' },
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
    name: 'playwright',
    keywords: ['browser', 'playwright', 'screenshot', 'automation', 'scrape', 'web', 'e2e'],
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    env: {},
  },
  {
    name: 'chrome-devtools',
    keywords: ['devtools', 'chrome', 'performance', 'debug', 'console', 'network', 'lighthouse'],
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    env: {},
  },
  {
    name: 'sentry',
    keywords: ['sentry', 'error', 'issue', 'exception', 'crash', 'monitoring', 'debug'],
    command: 'npx',
    args: ['-y', '@sentry/mcp-server'],
    // Self-hosted Sentry additionally accepts SENTRY_HOST; it is optional, so
    // it is not a required slot here.
    env: { SENTRY_ACCESS_TOKEN: '' },
    envPlaceholders: { SENTRY_ACCESS_TOKEN: 'sntrys_...' },
  },
  {
    name: 'abu-browser-bridge',
    keywords: ['browser', 'chrome', 'click', 'fill', 'screenshot', 'scrape', 'web', 'automation', 'tab'],
    command: 'npx',
    args: ['-y', 'abu-browser-bridge@latest'],
    env: {},
    bundledResourceDir: 'browser-extension',
    // Browser automation waits on real pages (popups, navigations), so it
    // needs a longer tool timeout than the store default.
    defaultTimeout: 120000,
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
 * Localized label for a configurable positional argument (e.g. 「数据库连接串」),
 * resolved from the current UI locale. Returns undefined when that slot has no
 * label — which, per the catalog's data invariants, means it is not one.
 */
export function getArgLabel(name: string, index: number): string | undefined {
  return getI18n().toolResult.system.mcpArgLabels[`${name}.${index}`];
}

/**
 * Localized setup note for a server that needs a step outside Abu before it
 * works (installing a Chrome extension, say). Returns undefined when there is
 * nothing extra to do.
 */
export function getSetupHint(name: string): string | undefined {
  return getI18n().toolResult.system.mcpSetupHints[name];
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

  return scored.map(({ entry }) => resolveRegistryEntryForHost(entry));
}

function resolveRegistryEntryForHost(
  entry: MCPRegistryEntry,
): MCPRegistryEntry {
  if (
    entry.name === 'abu-browser-bridge'
    && hasElectronCommandHost()
  ) {
    return {
      ...entry,
      command: ELECTRON_CHROME_BRIDGE_COMMAND,
      args: [],
    };
  }
  return entry;
}

/**
 * Install an MCP server by adding it to the store and connecting.
 *
 * `userArgs` fills the entry's `configurableArgs` slots positionally —
 * `userArgs[i]` goes into `configurableArgs[i].index`. The entry itself is
 * never written to: `BUILTIN_REGISTRY` is shared module state, so one user's
 * connection string must not become the next install's default.
 */
export async function installMCPServer(
  registryEntry: MCPRegistryEntry,
  userEnv?: Record<string, string>,
  userArgs?: string[],
): Promise<{ success: boolean; message: string; toolCount?: number }> {
  const store = useMCPStore.getState();
  const t = getI18n().toolResult.system;

  // Check if already configured
  if (store.servers[registryEntry.name]) {
    const entry = store.servers[registryEntry.name];
    if (entry.config.enabled === false) {
      return {
        success: false,
        message: format(t.mcpDisabled, { name: registryEntry.name }),
      };
    }
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

  // Fill the configurable positional slots into a copy of the entry's args.
  const finalArgs = [...registryEntry.args];
  const slots = registryEntry.configurableArgs ?? [];
  slots.forEach((slot, i) => {
    const supplied = userArgs?.[i];
    if (supplied !== undefined && supplied !== '') finalArgs[slot.index] = supplied;
  });
  const missingArgs = slots.filter((slot) => (finalArgs[slot.index] ?? '') === '');

  if (missingArgs.length > 0) {
    // The server would start and immediately exit, and the store would keep a
    // config nobody can tell apart from a working one. Refuse before writing.
    const labels = missingArgs
      .map((slot) => getArgLabel(registryEntry.name, slot.index) ?? `#${slot.index}`)
      .join(', ');
    return {
      success: false,
      message: format(t.mcpMissingArg, { name: registryEntry.name, label: labels }),
    };
  }

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
    args: finalArgs,
    env: finalEnv,
    enabled: true,
    // Omitted, not written as undefined: the store default applies when the
    // entry does not ask for a longer tool timeout.
    ...(registryEntry.defaultTimeout !== undefined ? { timeout: registryEntry.defaultTimeout } : {}),
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
  const entry = BUILTIN_REGISTRY.find((candidate) => candidate.name === name);
  return entry ? resolveRegistryEntryForHost(entry) : undefined;
}

/**
 * Prepare Abu's first-party Chrome bridge before the MCP store starts its
 * normal auto-connect pass. Electron uses the bundled runtime command; the
 * legacy Tauri host keeps its existing npx configuration untouched.
 *
 * A user's explicit disconnect is preserved (`enabled: false`). New Electron
 * installs get the service enabled by default so the only remaining setup is
 * Chrome's own extension confirmation.
 */
export function provisionFirstPartyMCPServers(): void {
  if (!hasElectronCommandHost()) return;

  const entry = getRegistryEntry('abu-browser-bridge');
  if (!entry) return;
  const store = useMCPStore.getState();
  const existing = store.servers[entry.name];
  if (!existing) {
    store.addServer({
      name: entry.name,
      transport: 'stdio',
      command: entry.command,
      args: entry.args,
      env: entry.env,
      enabled: true,
    });
    return;
  }

  store.updateServer(entry.name, {
    transport: 'stdio',
    command: entry.command,
    args: entry.args,
    env: entry.env,
  });
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

  // Dev mode: Electron resolves from the repository root, while Tauri resolves
  // from src-tauri/. Prefer the extension's real build output, then retain the
  // compatibility copy used by the legacy host.
  const { resolve } = await import('@tauri-apps/api/path');
  const candidates = dirName === 'browser-extension'
    ? [
        'abu-chrome-extension/dist',
        '../abu-chrome-extension/dist',
        'src-tauri/browser-extension',
        dirName,
        `../${dirName}`,
      ]
    : [dirName, `../${dirName}`];
  for (const candidate of candidates) {
    try {
      const p = await resolve(candidate);
      if (p && await exists(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

/** Resolve a registry entry's bundled companion without installing it. */
export async function resolveMCPCompanionResource(
  name: string,
): Promise<string | null> {
  const dirName = getRegistryEntry(name)?.bundledResourceDir;
  return dirName ? resolveBundledResource(dirName) : null;
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
    const configured = store.servers[name];
    if (configured.config.enabled === false) {
      return {
        status: 'needs_config',
        message: format(t.mcpDisabled, { name }),
        extensionPath,
      };
    }
    if (
      entry
      && entry.name === 'abu-browser-bridge'
      && entry.command === ELECTRON_CHROME_BRIDGE_COMMAND
      && (
        configured.config.command !== entry.command
        || JSON.stringify(configured.config.args ?? []) !== JSON.stringify(entry.args)
      )
    ) {
      store.updateServer(name, {
        transport: 'stdio',
        command: entry.command,
        args: entry.args,
        env: entry.env,
      });
    }
    const server = useMCPStore.getState().servers[name];
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

  // Check if env vars or configurable positional arguments are needed. An
  // unfilled slot is the same class of problem as an unset token — the server
  // cannot start and only the user can supply the value — so it takes the same
  // needs_config exit rather than falling through to an install that fails.
  const missingEnv = Object.entries(entry.env).filter(([, v]) => v === '').map(([k]) => k);
  const missingArgs = (entry.configurableArgs ?? [])
    .filter((slot) => (entry.args[slot.index] ?? '') === '');
  if (missingEnv.length > 0 || missingArgs.length > 0) {
    const hints = [
      ...missingEnv.map((k) => {
        const hint = getEnvHint(k);
        return hint ? `${k}: ${hint}` : k;
      }),
      ...missingArgs.map((slot) => getArgLabel(name, slot.index) ?? `#${slot.index}`),
    ];
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
