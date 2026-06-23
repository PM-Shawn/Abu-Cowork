// src/stores/enterpriseSkillStore.ts
import { create } from 'zustand'

export interface CatalogEntry {
  id: string
  name: string
  description?: string
  latestVersion: string
  latestVersionId: string
}

export interface InstalledRow {
  name: string
  installedVersion: string
  path: string
}

interface EnterpriseSkillState {
  catalog: CatalogEntry[] | null
  installed: InstalledRow[]
  lastSyncedAt: number | null
  syncError: string | null
}

interface EnterpriseSkillActions {
  setCatalog: (c: CatalogEntry[]) => void
  setInstalled: (i: InstalledRow[]) => void
  setSyncError: (e: string | null) => void
  markSynced: () => void
}

type EnterpriseSkillStore = EnterpriseSkillState & EnterpriseSkillActions

export const useEnterpriseSkillStore = create<EnterpriseSkillStore>(set => ({
  catalog: null,
  installed: [],
  lastSyncedAt: null,
  syncError: null,
  setCatalog: c => set({ catalog: c }),
  setInstalled: i => set({ installed: i }),
  setSyncError: e => set({ syncError: e }),
  markSynced: () => set({ lastSyncedAt: Date.now() }),
}))
