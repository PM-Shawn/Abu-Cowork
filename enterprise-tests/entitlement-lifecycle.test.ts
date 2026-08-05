import { describe, expect, it, vi } from 'vitest'

const moduleFlags = vi.hoisted(() => ({ skills: false, mcp: false, kb: false }))
const subscription = vi.hoisted(() => ({ callback: null as null | (() => void) }))
const calls = vi.hoisted(() => ({
  startSkills: vi.fn(), stopSkills: vi.fn(),
  startMcp: vi.fn(), stopMcp: vi.fn(),
  startKb: vi.fn(), stopKb: vi.fn(),
  reloadMcp: vi.fn(async () => undefined), disconnectMcp: vi.fn(async () => undefined),
  registerKb: vi.fn(async () => undefined), unregisterKb: vi.fn(),
}))

vi.mock('@enterprise-modules/components/KbBrowser', () => ({}))
vi.mock('@enterprise-modules/components/PersonalKbView', () => ({}))
vi.mock('@enterprise-modules/components/EnterpriseSkillTab', () => ({}))
vi.mock('@enterprise-modules/components/EnterpriseMcpTab', () => ({}))
vi.mock('@enterprise-modules/components/MeTransparencyView', () => ({}))
vi.mock('@enterprise-modules/components/MigrationWizard', () => ({}))

vi.mock('@enterprise-modules/core/enterprise/entitlement', () => ({
  isEnterpriseModuleActive: (module: keyof typeof moduleFlags) => moduleFlags[module],
}))
vi.mock('@enterprise-modules/stores/enterpriseStore', () => ({
  useEnterpriseStore: {
    subscribe: vi.fn((callback: () => void) => {
      subscription.callback = callback
      return () => { subscription.callback = null }
    }),
  },
}))
vi.mock('@enterprise-modules/core/skill/catalog-sync', () => ({
  startCatalogSync: calls.startSkills, stopCatalogSync: calls.stopSkills,
}))
vi.mock('@enterprise-modules/core/mcp/catalog-sync', () => ({
  startMcpCatalogSync: calls.startMcp, stopMcpCatalogSync: calls.stopMcp,
}))
vi.mock('@enterprise-modules/core/kb/catalog-sync', () => ({
  startKbCatalogSync: calls.startKb, stopKbCatalogSync: calls.stopKb,
}))
vi.mock('@enterprise-modules/core/mcp/loader', () => ({
  reloadEnterpriseMcpConnections: calls.reloadMcp,
  disconnectEnterpriseMcpConnections: calls.disconnectMcp,
}))
vi.mock('@enterprise-modules/tools/enterprise-kb-query', () => ({
  registerEnterpriseKbTool: calls.registerKb,
  unregisterEnterpriseKbTool: calls.unregisterKb,
}))

import { initEnterpriseModules } from '@enterprise-modules'

describe('enterprise entitlement lifecycle', () => {
  it('starts only licensed modules and retracts them when the live session loses entitlement', async () => {
    moduleFlags.skills = true
    moduleFlags.mcp = true
    moduleFlags.kb = true
    await initEnterpriseModules()

    expect(calls.startSkills).toHaveBeenCalled()
    expect(calls.startMcp).toHaveBeenCalled()
    expect(calls.reloadMcp).toHaveBeenCalled()
    expect(calls.startKb).toHaveBeenCalled()
    expect(calls.registerKb).toHaveBeenCalled()

    moduleFlags.skills = false
    moduleFlags.mcp = false
    moduleFlags.kb = false
    subscription.callback?.()

    await vi.waitFor(() => {
      expect(calls.stopSkills).toHaveBeenCalled()
      expect(calls.stopMcp).toHaveBeenCalled()
      expect(calls.disconnectMcp).toHaveBeenCalled()
      expect(calls.stopKb).toHaveBeenCalled()
      expect(calls.unregisterKb).toHaveBeenCalled()
    })
  })
})
