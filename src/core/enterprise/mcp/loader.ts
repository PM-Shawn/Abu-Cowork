// src/core/enterprise/mcp/loader.ts
// Bridges enterprise MCP entries (from local-store.ts) into the shared mcpManager.
// Enterprise MCP servers use HTTP transport with bearer-token auth.
// Server names are prefixed with "enterprise__" to avoid collisions with user-managed servers.
import { mcpManager, type MCPServerConfig } from '@/core/mcp/client'
import { loadInstalled } from './local-store'

const ENTERPRISE_PREFIX = 'enterprise__'

function entryToConfig(entry: {
  id: string
  name: string
  endpoint: string
  transportType: string
  credential: string
}): MCPServerConfig {
  return {
    name: `${ENTERPRISE_PREFIX}${entry.id}`,
    transport: 'http',
    url: entry.endpoint,
    headers: { Authorization: `Bearer ${entry.credential}` },
    enabled: true,
  }
}

/**
 * Load enterprise MCP entries from disk and connect any that are not yet connected.
 * Disconnects entries that have been removed from the local store.
 * Called at app startup and after install/uninstall operations.
 */
export async function reloadEnterpriseMcpConnections(): Promise<void> {
  const installed = await loadInstalled()
  const installedIds = new Set(installed.map(e => e.id))

  // Disconnect enterprise servers that are no longer installed
  const connected = mcpManager.getConnectedServers()
  for (const name of connected) {
    if (!name.startsWith(ENTERPRISE_PREFIX)) continue
    const serverId = name.slice(ENTERPRISE_PREFIX.length)
    if (!installedIds.has(serverId)) {
      await mcpManager.disconnectServer(name).catch((err: unknown) => {
        console.warn(`[enterprise-mcp] Failed to disconnect ${name}:`, err)
      })
    }
  }

  // Connect newly installed enterprise servers
  for (const entry of installed) {
    const serverName = `${ENTERPRISE_PREFIX}${entry.id}`
    if (mcpManager.isConnected(serverName)) continue
    const config = entryToConfig(entry)
    await mcpManager.connectServer(config).catch((err: unknown) => {
      console.warn(`[enterprise-mcp] Failed to connect ${entry.name}:`, err)
    })
  }
}
