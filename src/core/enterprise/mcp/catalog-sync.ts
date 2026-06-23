// src/core/enterprise/mcp/catalog-sync.ts
import { callEnterprise } from '@/core/enterprise/api'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { useEnterpriseMcpStore, type CatalogEntry } from '@/stores/enterpriseMcpStore'
import { loadInstalled } from './local-store'

const INTERVAL_MS = 5 * 60 * 1000
let timer: number | null = null

export async function syncMcpCatalogOnce(): Promise<void> {
  const mode = useEnterpriseStore.getState().mode
  if (mode.kind === 'personal') return

  const store = useEnterpriseMcpStore.getState()

  // Hydrate installed from filesystem
  try {
    const inst = await loadInstalled()
    store.setInstalled(inst.map(e => ({
      id: e.id,
      name: e.name,
      endpoint: e.endpoint,
      credentialExpiresAt: e.credentialExpiresAt,
    })))
  } catch { /* ignore */ }

  if (mode.kind === 'offline') {
    store.setSyncError('offline; using cached MCP entries')
    return
  }

  try {
    const r = await callEnterprise<{ items: CatalogEntry[] }>('/api/mcp/catalog')
    store.setCatalog(r.items)
    store.setSyncError(null)
  } catch (e) {
    store.setSyncError((e as Error).message)
  }
}

export function startMcpCatalogSync(): void {
  if (timer != null) return
  void syncMcpCatalogOnce()
  timer = window.setInterval(() => { void syncMcpCatalogOnce() }, INTERVAL_MS) as unknown as number
}

export function stopMcpCatalogSync(): void {
  if (timer != null) { window.clearInterval(timer); timer = null }
}
