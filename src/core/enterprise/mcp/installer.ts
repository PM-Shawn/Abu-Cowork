// src/core/enterprise/mcp/installer.ts
// MCP install/uninstall — writes credential + endpoint to local JSON index.
// Unlike skill install, no file download is needed; MCP auth is bearer-token over HTTP.
import { callEnterprise } from '@/core/enterprise/api'
import { useEnterpriseMcpStore } from '@/stores/enterpriseMcpStore'
import { loadInstalled, saveInstalled, type LocalMcpEntry } from './local-store'
import { reloadEnterpriseMcpConnections } from './loader'

interface CredentialResponse {
  token: string
  expires_at: string
  endpoint: string
  transport_type: string
}

export async function installMcp(serverId: string, name: string): Promise<void> {
  const cred = await callEnterprise<CredentialResponse>(
    `/api/mcp/servers/${serverId}/credential`,
    { method: 'POST' }
  )

  const current = await loadInstalled()
  const entry: LocalMcpEntry = {
    id: serverId,
    registryId: '',
    name,
    endpoint: cred.endpoint,
    transportType: cred.transport_type,
    credential: cred.token,
    credentialExpiresAt: cred.expires_at,
    addedAt: new Date().toISOString(),
  }
  const next = [...current.filter(x => x.id !== serverId), entry]
  await saveInstalled(next)

  useEnterpriseMcpStore.getState().setInstalled(
    next.map(e => ({ id: e.id, name: e.name, endpoint: e.endpoint, credentialExpiresAt: e.credentialExpiresAt }))
  )

  // Notify MCP loader to pick up the new connection
  await reloadEnterpriseMcpConnections()
}

export async function uninstallMcp(serverId: string): Promise<void> {
  const current = await loadInstalled()
  const next = current.filter(x => x.id !== serverId)
  await saveInstalled(next)

  useEnterpriseMcpStore.getState().setInstalled(
    next.map(e => ({ id: e.id, name: e.name, endpoint: e.endpoint, credentialExpiresAt: e.credentialExpiresAt }))
  )

  // Notify MCP loader to disconnect and remove
  await reloadEnterpriseMcpConnections()
}
