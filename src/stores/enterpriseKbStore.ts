// src/stores/enterpriseKbStore.ts
import { create } from 'zustand'
import type { KbCatalogEntry } from '@/core/enterprise/kb/api'

interface State {
  catalog: KbCatalogEntry[] | null
  syncError: string | null
  lastSyncedAt: number | null
  setCatalog: (c: KbCatalogEntry[]) => void
  setSyncError: (e: string | null) => void
  markSynced: () => void
}

export const useEnterpriseKbStore = create<State>(set => ({
  catalog: null, syncError: null, lastSyncedAt: null,
  setCatalog: c => set({ catalog: c }),
  setSyncError: e => set({ syncError: e }),
  markSynced: () => set({ lastSyncedAt: Date.now() }),
}))
