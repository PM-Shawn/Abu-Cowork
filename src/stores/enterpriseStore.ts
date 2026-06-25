// src/stores/enterpriseStore.ts
// Enterprise mode store — ephemeral in Zustand (state is loaded from filesystem via boot.ts,
// not from localStorage), so no persist middleware is used by design.
import { create } from 'zustand'
import type { EnterpriseBinding, EnterpriseConfigSnapshot, EnterpriseMode } from '@/core/enterprise/types'
import { loadBinding, saveBinding, clearBinding } from '@/core/enterprise/boot'

interface EnterpriseState {
  mode: EnterpriseMode
  initialized: boolean
}

interface EnterpriseActions {
  init: () => Promise<void>
  bind: (b: EnterpriseBinding) => Promise<void>
  unbind: () => Promise<void>
  setConfig: (c: EnterpriseConfigSnapshot) => void
  setOffline: (reason: string) => void
}

type EnterpriseStore = EnterpriseState & EnterpriseActions

export const useEnterpriseStore = create<EnterpriseStore>((set, get) => ({
  mode: { kind: 'personal' },
  initialized: false,
  async init() {
    const b = await loadBinding()
    set({ mode: b ? { kind: 'enterprise', binding: b, config: null } : { kind: 'personal' }, initialized: true })
  },
  async bind(b) {
    await saveBinding(b)
    set({ mode: { kind: 'enterprise', binding: b, config: null } })
  },
  async unbind() {
    await clearBinding()
    set({ mode: { kind: 'personal' } })
  },
  setConfig(c) {
    const m = get().mode
    if (m.kind === 'enterprise') set({ mode: { ...m, config: c } })
    if (m.kind === 'offline') set({ mode: { kind: 'enterprise', binding: m.binding, config: c } })
  },
  setOffline(reason) {
    const m = get().mode
    if (m.kind === 'enterprise') {
      set({ mode: { kind: 'offline', binding: m.binding, lastConfig: m.config, reason } })
    }
  },
}))

export function isEnterprise(): boolean {
  return useEnterpriseStore.getState().mode.kind !== 'personal'
}

export function getBinding(): EnterpriseBinding | null {
  const m = useEnterpriseStore.getState().mode
  return m.kind === 'enterprise' || m.kind === 'offline' ? m.binding : null
}
