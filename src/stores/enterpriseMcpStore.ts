// src/stores/enterpriseMcpStore.ts
import { create } from 'zustand'

export interface CatalogEntry {
  id: string
  registryId: string
  name: string
  description?: string
  endpoint: string
  transportType: string
}

export interface InstalledRow {
  id: string
  name: string
  endpoint: string
  credentialExpiresAt: string
}

interface EnterpriseMcpState {
  catalog: CatalogEntry[] | null
  installed: InstalledRow[]
  syncError: string | null
}

interface EnterpriseMcpActions {
  setCatalog: (c: CatalogEntry[]) => void
  setInstalled: (i: InstalledRow[]) => void
  setSyncError: (e: string | null) => void
}

type EnterpriseMcpStore = EnterpriseMcpState & EnterpriseMcpActions

export const useEnterpriseMcpStore = create<EnterpriseMcpStore>(set => ({
  catalog: null,
  installed: [],
  syncError: null,
  setCatalog: c => set({ catalog: c }),
  setInstalled: i => set({ installed: i }),
  setSyncError: e => set({ syncError: e }),
}))
