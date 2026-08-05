import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isEnterpriseModuleActive } from '../entitlement'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import type { EnterpriseBinding, EnterpriseConfigSnapshot } from '../types'

const binding: EnterpriseBinding = {
  serverUrl: 'https://enterprise.example', orgId: 'org-1', orgName: 'Org',
  userId: 'user-1', userName: 'User', userEmail: 'user@example.com',
  deptId: null, roleId: null, accessToken: 'token', boundAt: '2026-08-05T00:00:00Z',
  llmEndpoint: null, llmVirtualKey: null, llmKeyExpiresAt: null,
}

function config(expiresAt: string): EnterpriseConfigSnapshot {
  return {
    brand: { name: 'Org', logoUrl: null, primaryColor: null }, defaultSoul: null,
    policyDefaults: {}, modules: ['skills', 'mcp', 'kb'], licenseStatus: 'valid',
    licenseExpiresAt: expiresAt, serverTime: '2026-08-05T00:00:00Z', fetchedAt: Date.now(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-05T12:00:00Z'))
})

afterEach(() => vi.useRealTimers())

describe('local enterprise entitlement', () => {
  it('requires a live enterprise mode, valid status, module and future signed expiry', () => {
    useEnterpriseStore.setState({
      mode: { kind: 'enterprise', binding, config: config('2026-08-05T12:00:01Z') },
      initialized: true,
    })
    expect(isEnterpriseModuleActive('skills')).toBe(true)
    expect(isEnterpriseModuleActive('mcp')).toBe(true)

    vi.setSystemTime(new Date('2026-08-05T12:00:02Z'))
    expect(isEnterpriseModuleActive('skills')).toBe(false)
    expect(isEnterpriseModuleActive('mcp')).toBe(false)
  })

  it('does not trust a cached valid snapshot while offline', () => {
    const lastConfig = config('2099-01-01T00:00:00Z')
    useEnterpriseStore.setState({ mode: { kind: 'offline', binding, lastConfig, reason: 'network unavailable' } })
    expect(isEnterpriseModuleActive('kb')).toBe(false)
  })
})
