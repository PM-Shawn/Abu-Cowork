import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEnterpriseEntitlementMirror,
  applyEnterpriseEntitlementSnapshot,
  isEnterpriseModuleActive,
} from './enterpriseEntitlementMirror'
import { IS_ENTERPRISE_BUILD } from '@/config/featureGates'

describe('enterprise entitlement mirror', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'))
    __resetEnterpriseEntitlementMirror()
  })

  afterEach(() => vi.useRealTimers())

  it('starts fail-closed and accepts only a live valid module grant', () => {
    expect(isEnterpriseModuleActive('skills')).toBe(false)
    applyEnterpriseEntitlementSnapshot({
      mode: 'enterprise',
      licenseStatus: 'valid',
      licenseExpiresAt: '2026-08-05T12:00:01Z',
      modules: ['skills'],
    })
    expect(isEnterpriseModuleActive('skills')).toBe(IS_ENTERPRISE_BUILD)
    expect(isEnterpriseModuleActive('mcp')).toBe(false)

    vi.setSystemTime(new Date('2026-08-05T12:00:02Z'))
    expect(isEnterpriseModuleActive('skills')).toBe(false)
  })

  it('revokes access immediately on offline or malformed pushes', () => {
    applyEnterpriseEntitlementSnapshot({
      mode: 'enterprise', licenseStatus: 'valid',
      licenseExpiresAt: '2099-01-01T00:00:00Z', modules: ['kb'],
    })
    expect(isEnterpriseModuleActive('kb')).toBe(IS_ENTERPRISE_BUILD)

    applyEnterpriseEntitlementSnapshot({
      mode: 'offline', licenseStatus: 'valid',
      licenseExpiresAt: '2099-01-01T00:00:00Z', modules: ['kb'],
    })
    expect(isEnterpriseModuleActive('kb')).toBe(false)

    applyEnterpriseEntitlementSnapshot({ mode: 'enterprise', modules: 'kb' })
    expect(isEnterpriseModuleActive('kb')).toBe(false)
  })
})
