// src/core/enterprise/skill/catalog-sync.ts
import { callEnterprise } from '@/core/enterprise/api'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { useEnterpriseSkillStore, type CatalogEntry } from '@/stores/enterpriseSkillStore'
import { loadCatalog, saveCatalog, listInstalled } from './local-store'

const POLL_INTERVAL_MS = 5 * 60 * 1000
let timer: number | null = null

export async function syncCatalogOnce(): Promise<void> {
  const mode = useEnterpriseStore.getState().mode
  if (mode.kind === 'personal') return

  const store = useEnterpriseSkillStore.getState()

  // hydrate installed from filesystem
  try {
    const inst = await listInstalled()
    store.setInstalled(inst)
  } catch { /* ignore */ }

  if (mode.kind === 'offline') {
    // load last-saved catalog
    const cached = await loadCatalog().catch(() => null)
    if (cached) store.setCatalog(cached.items as CatalogEntry[])
    store.setSyncError('offline; showing last-known catalog')
    return
  }

  try {
    const r = await callEnterprise<{ items: CatalogEntry[] }>('/api/skills/catalog')
    store.setCatalog(r.items)
    store.markSynced()
    store.setSyncError(null)
    await saveCatalog({
      fetchedAt: Date.now(),
      serverUrl: (mode as { kind: 'enterprise'; binding: { serverUrl: string } }).binding?.serverUrl ?? '',
      items: r.items.map(x => ({ id: x.id, name: x.name, latestVersion: x.latestVersion, latestVersionId: x.latestVersionId })),
    })
  } catch (e) {
    store.setSyncError((e as Error).message)
    // fall back to cached catalog if available
    const cached = await loadCatalog().catch(() => null)
    if (cached && !store.catalog) store.setCatalog(cached.items as CatalogEntry[])
  }
}

export function startCatalogSync(): void {
  if (timer != null) return
  void syncCatalogOnce()
  timer = window.setInterval(() => { void syncCatalogOnce() }, POLL_INTERVAL_MS) as unknown as number
}

export function stopCatalogSync(): void {
  if (timer != null) { window.clearInterval(timer); timer = null }
}
