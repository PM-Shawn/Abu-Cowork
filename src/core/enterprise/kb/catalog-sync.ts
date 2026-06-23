// src/core/enterprise/kb/catalog-sync.ts
import { listKbs } from './api'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { useEnterpriseKbStore } from '@/stores/enterpriseKbStore'

const POLL_INTERVAL_MS = 5 * 60 * 1000
let timer: number | null = null

export async function syncKbCatalogOnce(): Promise<void> {
  const mode = useEnterpriseStore.getState().mode
  if (mode.kind === 'personal') return
  const store = useEnterpriseKbStore.getState()
  if (mode.kind === 'offline') { store.setSyncError('offline'); return }
  try {
    const items = await listKbs()
    store.setCatalog(items)
    store.markSynced()
    store.setSyncError(null)
  } catch (e) { store.setSyncError((e as Error).message) }
}

export function startKbCatalogSync(): void {
  if (timer != null) return
  void syncKbCatalogOnce()
  timer = window.setInterval(() => { void syncKbCatalogOnce() }, POLL_INTERVAL_MS) as unknown as number
}

export function stopKbCatalogSync(): void {
  if (timer != null) { window.clearInterval(timer); timer = null }
}
