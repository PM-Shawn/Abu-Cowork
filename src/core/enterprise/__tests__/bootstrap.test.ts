// src/core/enterprise/__tests__/bootstrap.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const BASE = 'https://abu.acme.com'

function makeFetchResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response
}

describe('fetchBootstrap', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls GET {serverUrl}/api/client/v1/bootstrap with no auth headers', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValue(
      makeFetchResponse({
        instanceName: 'Test',
        branding: { name: 'Test', logoUrl: null, primaryColor: null },
        auth: { methods: ['password'] },
        registration: { mode: 'open_approval', domainAllowlist: [] },
        minClientVersion: '0.6.0',
        configVersion: 'sha256-abcd1234',
      })
    )

    const { fetchBootstrap } = await import('../bootstrap')
    await fetchBootstrap(BASE)

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe(`${BASE}/api/client/v1/bootstrap`)
    // No Authorization header for unauthenticated endpoint
    const headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined
    expect(headers?.['authorization']).toBeUndefined()
  })

  it('successfully parses full BootstrapDTO (all fields including SSO)', async () => {
    const mockFetch = vi.mocked(fetch)
    const payload = {
      instanceName: 'Acme Abu',
      branding: { name: 'Acme Abu', logoUrl: 'https://console.acme.com/logo.png', primaryColor: '#1677FF' },
      auth: {
        methods: ['password', 'magic_link', 'sso'],
        sso: { provider: 'feishu', buttonLabel: '用飞书登录' },
      },
      registration: { mode: 'open_approval', domainAllowlist: ['acme.com', 'acme.org'] },
      minClientVersion: '0.6.0',
      configVersion: 'sha256-abcd1234',
    }
    mockFetch.mockResolvedValue(makeFetchResponse(payload))

    const { fetchBootstrap } = await import('../bootstrap')
    const result = await fetchBootstrap(BASE)

    expect(result.instanceName).toBe('Acme Abu')
    expect(result.branding.primaryColor).toBe('#1677FF')
    expect(result.auth.methods).toEqual(['password', 'magic_link', 'sso'])
    expect(result.auth.sso?.provider).toBe('feishu')
    expect(result.auth.sso?.buttonLabel).toBe('用飞书登录')
    expect(result.registration.mode).toBe('open_approval')
    expect(result.registration.domainAllowlist).toEqual(['acme.com', 'acme.org'])
    expect(result.minClientVersion).toBe('0.6.0')
    expect(result.configVersion).toBe('sha256-abcd1234')
  })

  it('parses BootstrapDTO with only password method (no sso block)', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValue(
      makeFetchResponse({
        instanceName: 'Simple Corp',
        branding: { name: 'Simple Corp', logoUrl: null, primaryColor: null },
        auth: { methods: ['password'] },
        registration: { mode: 'invite', domainAllowlist: [] },
        minClientVersion: '0.5.0',
        configVersion: 'sha256-0000',
      })
    )

    const { fetchBootstrap } = await import('../bootstrap')
    const result = await fetchBootstrap(BASE)

    expect(result.auth.methods).toEqual(['password'])
    expect(result.auth.sso).toBeUndefined()
    expect(result.registration.mode).toBe('invite')
  })

  it('handles trailing slash in serverUrl correctly', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValue(
      makeFetchResponse({
        instanceName: 'X',
        branding: { name: 'X', logoUrl: null, primaryColor: null },
        auth: { methods: ['password'] },
        registration: { mode: 'invite', domainAllowlist: [] },
        minClientVersion: '0.6.0',
        configVersion: 'sha256-x',
      })
    )

    const { fetchBootstrap } = await import('../bootstrap')
    await fetchBootstrap('https://abu.acme.com/')

    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://abu.acme.com/api/client/v1/bootstrap')
  })

  it('throws EnterpriseApiError on HTTP 500', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValue(
      makeFetchResponse({ error: 'internal_error', message: 'DB down' }, 500)
    )

    const { fetchBootstrap, EnterpriseBootstrapError } = await import('../bootstrap')
    await expect(fetchBootstrap(BASE)).rejects.toBeInstanceOf(EnterpriseBootstrapError)
  })

  it('EnterpriseBootstrapError carries status and body', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValue(
      makeFetchResponse({ error: 'internal_error', message: 'down' }, 500)
    )

    const { fetchBootstrap, EnterpriseBootstrapError } = await import('../bootstrap')
    let caught: unknown
    try {
      await fetchBootstrap(BASE)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(EnterpriseBootstrapError)
    const err = caught as InstanceType<typeof EnterpriseBootstrapError>
    expect(err.status).toBe(500)
    expect((err.body as { error: string }).error).toBe('internal_error')
  })

  it('throws EnterpriseBootstrapError on HTTP 404', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValue(
      makeFetchResponse({ error: 'not_found', message: 'no such endpoint' }, 404)
    )

    const { fetchBootstrap, EnterpriseBootstrapError } = await import('../bootstrap')
    await expect(fetchBootstrap(BASE)).rejects.toBeInstanceOf(EnterpriseBootstrapError)
  })

  it('propagates network-level errors (fetch rejects)', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'))

    const { fetchBootstrap } = await import('../bootstrap')
    await expect(fetchBootstrap(BASE)).rejects.toThrow('Failed to fetch')
  })
})
