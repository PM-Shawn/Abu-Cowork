// src/core/enterprise/__tests__/llm-resolver.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/stores/enterpriseStore', () => ({
  useEnterpriseStore: { getState: vi.fn() },
}))

describe('resolveEnterpriseLlm', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null in personal mode', async () => {
    const { useEnterpriseStore } = await import('@/stores/enterpriseStore')
    ;(useEnterpriseStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ mode: { kind: 'personal' } })
    const { resolveEnterpriseLlm } = await import('../llm-resolver')
    expect(resolveEnterpriseLlm()).toBeNull()
  })

  it('returns endpoint + key in enterprise mode', async () => {
    const { useEnterpriseStore } = await import('@/stores/enterpriseStore')
    ;(useEnterpriseStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      mode: { kind: 'enterprise', binding: { llmEndpoint: 'https://x/litellm', llmVirtualKey: 'sk-vk-xxx' }, config: null },
    })
    const { resolveEnterpriseLlm } = await import('../llm-resolver')
    const r = resolveEnterpriseLlm()
    expect(r?.baseUrl).toBe('https://x/litellm')
    expect(r?.apiKey).toBe('sk-vk-xxx')
  })

  it('returns null if binding lacks llm key (legacy bind)', async () => {
    const { useEnterpriseStore } = await import('@/stores/enterpriseStore')
    ;(useEnterpriseStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      mode: { kind: 'enterprise', binding: { llmEndpoint: null, llmVirtualKey: null }, config: null },
    })
    const { resolveEnterpriseLlm } = await import('../llm-resolver')
    expect(resolveEnterpriseLlm()).toBeNull()
  })

  it('returns null when offline (offline = gateway unreachable)', async () => {
    const { useEnterpriseStore } = await import('@/stores/enterpriseStore')
    ;(useEnterpriseStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      mode: { kind: 'offline', binding: { llmEndpoint: 'x', llmVirtualKey: 'k' }, lastConfig: null, reason: 'timeout' },
    })
    const { resolveEnterpriseLlm } = await import('../llm-resolver')
    expect(resolveEnterpriseLlm()).toBeNull()
  })

  it('isEnterpriseLlmEnforced returns true even when offline (no fallback to personal)', async () => {
    const { useEnterpriseStore } = await import('@/stores/enterpriseStore')
    ;(useEnterpriseStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      mode: { kind: 'offline', binding: { llmEndpoint: 'x', llmVirtualKey: 'k' }, lastConfig: null, reason: 'timeout' },
    })
    const { isEnterpriseLlmEnforced } = await import('../llm-resolver')
    expect(isEnterpriseLlmEnforced()).toBe(true)
  })

  it('isEnterpriseLlmEnforced returns false in personal mode', async () => {
    const { useEnterpriseStore } = await import('@/stores/enterpriseStore')
    ;(useEnterpriseStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ mode: { kind: 'personal' } })
    const { isEnterpriseLlmEnforced } = await import('../llm-resolver')
    expect(isEnterpriseLlmEnforced()).toBe(false)
  })
})
