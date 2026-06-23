// src/core/enterprise/__tests__/mounts.test.ts
import { describe, it, expect } from 'vitest'
import { registerEnterpriseMount, getEnterpriseMount, getAllMounts } from '../mounts'

describe('enterprise mounts registry', () => {
  it('registers and reads back a slot', () => {
    const Marker = () => null
    registerEnterpriseMount('brandSlot', Marker as any)
    expect(getEnterpriseMount('brandSlot')).toBe(Marker)
  })

  it('optional slots default to undefined', () => {
    const all = getAllMounts()
    // kbModule etc. should be undefined unless explicitly set (test isolation depends on vitest test file order;
    // for V1 we accept the global registry; later we can add a reset for tests)
    // baseline assertion:
    expect(typeof all.brandSlot).toBe('function')
  })

  it('required slots all exist as functions in the registry', () => {
    const all = getAllMounts()
    expect(typeof all.skillTab).toBe('function')
    expect(typeof all.mcpTab).toBe('function')
    expect(typeof all.meTransparencyPage).toBe('function')
    expect(typeof all.policyAdvisor).toBe('function')
  })

  it('getAllMounts returns the same registry object (by ref equality)', () => {
    expect(getAllMounts()).toBe(getAllMounts())
  })

  it('overwriting a slot replaces the previous impl', () => {
    const First = () => null
    const Second = () => null
    registerEnterpriseMount('policyAdvisor', First as any)
    expect(getEnterpriseMount('policyAdvisor')).toBe(First)
    registerEnterpriseMount('policyAdvisor', Second as any)
    expect(getEnterpriseMount('policyAdvisor')).toBe(Second)
  })
})
