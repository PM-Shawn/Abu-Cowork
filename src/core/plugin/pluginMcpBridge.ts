/**
 * Register / deregister a plugin's MCP servers in the MCP store.
 *
 * ## Why servers land DISABLED
 *
 * `mcpStore.connectAllEnabled` auto-connects every `enabled` server at boot
 * (`initMCPStoreSync`), and `addServer` defaults `enabled: true`. Registering a
 * plugin server with the default would therefore start third-party code on the
 * next launch, with no approval — the exact escalation the plugin gate exists
 * to prevent. So plugin servers are registered `enabled: false`: they appear in
 * the Connectors tab, and the user turns one on explicitly (that toggle is the
 * consent-to-run point). Tool calls then still pass the Batch-1
 * `classifyPluginTool` gate. Two consent points, both explicit.
 *
 * ## Why provenance lives here, not in mcpStore
 *
 * The install record's `contributed.mcpServers` already names what each plugin
 * brought in, so uninstall removes exactly those. Adding a `source` column to
 * the persisted core `mcpStore` would raise the blast radius (a migration bug
 * there breaks all MCP, not just plugins) for no correctness gain in the normal
 * flow: registration refuses to overwrite a pre-existing name, so a plugin can
 * only ever be credited with servers it actually created.
 */

import type { McpServerSpec } from './manifest';
import type { InstalledPlugin } from './installedStore';

/** The slice of the MCP store this bridge needs; injected for testing. */
export interface McpStoreOps {
  has: (name: string) => boolean;
  addServer: (config: {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    enabled: boolean;
  }) => void;
  removeServer: (name: string) => void;
}

export interface RegisterResult {
  /** Server names newly registered (disabled). */
  registered: string[];
  /** Names skipped because a server of that name already existed. */
  conflicts: string[];
}

/**
 * Register a plugin's declared MCP servers, disabled. A name already present in
 * the store is left untouched and reported as a conflict.
 */
export function registerPluginServers(
  mcpServers: Record<string, McpServerSpec> | undefined,
  store: McpStoreOps,
): RegisterResult {
  const registered: string[] = [];
  const conflicts: string[] = [];

  for (const [name, spec] of Object.entries(mcpServers ?? {})) {
    if (store.has(name)) {
      conflicts.push(name);
      continue;
    }
    store.addServer({
      name,
      command: spec.command,
      args: spec.args,
      env: spec.env,
      url: spec.url,
      enabled: false, // never auto-connect; the Connectors toggle is consent
    });
    registered.push(name);
  }

  return { registered, conflicts };
}

/** Remove the named servers from the store (skipping any already gone). */
export function deregisterPluginServers(names: string[], store: McpStoreOps): void {
  for (const name of names) {
    if (store.has(name)) store.removeServer(name);
  }
}

/**
 * server name → owning plugin name, across all installed plugins. Lets the
 * Connectors tab label a server "from plugin X" so users can tell a
 * plugin-contributed connector apart from one they configured by hand.
 */
export function pluginServerOwners(installed: InstalledPlugin[]): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const plugin of installed) {
    for (const server of plugin.contributed.mcpServers) owners[server] = plugin.name;
  }
  return owners;
}
