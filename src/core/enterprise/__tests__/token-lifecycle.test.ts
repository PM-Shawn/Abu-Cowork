// src/core/enterprise/__tests__/token-lifecycle.test.ts
//
// Covers O4: access+refresh token lifecycle — auto-refresh, session expiry,
// concurrent single-flight, and legacy binding tolerance.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { EnterpriseBinding } from '../types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response
}

/** Builds a binding that is about to expire (5s from now — within the 60s proactive window). */
function makeFreshBinding(overrides: Partial<EnterpriseBinding> = {}): EnterpriseBinding {
  return {
    serverUrl: 'https://abu.acme.com',
    orgId: 'org1',
    orgName: 'Acme',
    userId: 'u1',
    userName: 'Alice',
    userEmail: 'alice@acme.com',
    deptId: null,
    roleId: null,
    accessToken: 'old-access-token',
    accessExpiresAt: new Date(Date.now() + 5_000).toISOString(),  // expires in 5s — within 60s buffer
    refreshToken: 'old-refresh-token',
    boundAt: '2026-01-01T00:00:00Z',
    llmEndpoint: null,
    llmVirtualKey: null,
    llmKeyExpiresAt: null,
    ...overrides,
  }
}

/** Builds a binding whose access token is still valid for 10 minutes — outside proactive window. */
function makeValidBinding(overrides: Partial<EnterpriseBinding> = {}): EnterpriseBinding {
  return makeFreshBinding({
    accessExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...overrides,
  })
}

/** The token pair the mock refresh endpoint returns. */
const NEW_TOKENS = {
  access_token: 'new-access-token',
  token_type: 'Bearer',
  expires_in: 900,
  refresh_token: 'new-refresh-token',
  refresh_idle_expires_at: '2026-07-10T00:00:00Z',
  refresh_absolute_expires_at: '2026-09-24T00:00:00Z',
  family_id: 'family-uuid',
}

// ─── Module mocks ─────────────────────────────────────────────────────────────

const mockGetBinding = vi.fn<[], EnterpriseBinding | null>()
const mockBind = vi.fn<[EnterpriseBinding], Promise<void>>().mockResolvedValue(undefined)

vi.mock('@/stores/enterpriseStore', () => ({
  getBinding: mockGetBinding,
  useEnterpriseStore: {
    getState: () => ({ bind: mockBind }),
  },
}))

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('token-lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    // Reset the single-flight lock between tests so tests are isolated.
    // _resetInflightForTesting is an internal test helper exported from api.ts.
    vi.resetModules()
  })

  // ── refreshAccessToken ───────────────────────────────────────────────────

  describe('refreshAccessToken', () => {
    it('calls POST /api/client/v1/auth/refresh with the refresh_token body', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(NEW_TOKENS))

      const { refreshAccessToken } = await import('../token-refresh')
      await refreshAccessToken('https://abu.acme.com', 'rt-abc')

      expect(fetch).toHaveBeenCalledOnce()
      const [url, init] = vi.mocked(fetch).mock.calls[0]
      expect(url).toBe('https://abu.acme.com/api/client/v1/auth/refresh')
      expect((init as RequestInit).method).toBe('POST')
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ refresh_token: 'rt-abc' })
    })

    it('strips trailing slash from serverUrl', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(NEW_TOKENS))

      const { refreshAccessToken } = await import('../token-refresh')
      await refreshAccessToken('https://abu.acme.com/', 'rt-abc')

      const [url] = vi.mocked(fetch).mock.calls[0]
      expect(url).toBe('https://abu.acme.com/api/client/v1/auth/refresh')
    })

    it('returns new accessToken, refreshToken, and computed accessExpiresAt', async () => {
      const now = Date.now()
      vi.setSystemTime(now)
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(NEW_TOKENS))

      const { refreshAccessToken } = await import('../token-refresh')
      const result = await refreshAccessToken('https://abu.acme.com', 'rt-abc')

      expect(result.accessToken).toBe('new-access-token')
      expect(result.refreshToken).toBe('new-refresh-token')
      // accessExpiresAt should be ~900s from "now"
      const expectedExpiry = new Date(now + 900 * 1000).toISOString()
      expect(result.accessExpiresAt).toBe(expectedExpiry)

      vi.useRealTimers()
    })

    it('throws TokenRefreshError on 401 unauthenticated', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        makeResponse({ error: 'unauthenticated', message: 'token expired' }, 401)
      )

      const { refreshAccessToken, TokenRefreshError } = await import('../token-refresh')
      await expect(refreshAccessToken('https://abu.acme.com', 'rt-expired')).rejects.toBeInstanceOf(TokenRefreshError)
    })

    it('throws TokenRefreshError with status and body on token_reuse_detected (401)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        makeResponse({ error: 'token_reuse_detected', message: 'replay' }, 401)
      )

      const { refreshAccessToken, TokenRefreshError } = await import('../token-refresh')
      let caught: InstanceType<typeof TokenRefreshError> | undefined
      try {
        await refreshAccessToken('https://abu.acme.com', 'rt-reused')
      } catch (e) {
        caught = e as InstanceType<typeof TokenRefreshError>
      }
      expect(caught).toBeInstanceOf(TokenRefreshError)
      expect(caught?.status).toBe(401)
      expect((caught?.body as { error: string }).error).toBe('token_reuse_detected')
    })

    it('throws TokenRefreshError on 403 account_suspended', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        makeResponse({ error: 'account_suspended' }, 403)
      )

      const { refreshAccessToken, TokenRefreshError } = await import('../token-refresh')
      await expect(refreshAccessToken('https://abu.acme.com', 'rt-x')).rejects.toBeInstanceOf(TokenRefreshError)
    })
  })

  // ── callEnterprise — proactive refresh ───────────────────────────────────

  describe('callEnterprise — proactive refresh (access token about to expire)', () => {
    it('refreshes before the request when accessExpiresAt is within the 60s buffer', async () => {
      const binding = makeFreshBinding()
      mockGetBinding.mockReturnValue(binding)

      // Make mockBind update what getBinding returns after the first call
      mockBind.mockImplementation(async (updated) => {
        mockGetBinding.mockReturnValue(updated)
      })

      // fetch call order: 1=POST /auth/refresh, 2=original GET /session
      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse(NEW_TOKENS))              // refresh
        .mockResolvedValueOnce(makeResponse({ status: 'ok' }))        // original request

      const { callEnterprise } = await import('../api')
      const result = await callEnterprise('/api/client/v1/session')

      expect(result).toEqual({ status: 'ok' })

      // Verify the refresh call happened first
      const calls = vi.mocked(fetch).mock.calls
      expect(calls).toHaveLength(2)
      expect(calls[0][0]).toContain('/auth/refresh')
      expect(calls[1][0]).toContain('/session')

      // Verify the original request used the NEW access token
      const sessionHeaders = calls[1][1]?.headers as Record<string, string>
      expect(sessionHeaders?.authorization).toBe('Bearer new-access-token')
    })

    it('does NOT refresh when accessExpiresAt is far in the future', async () => {
      const binding = makeValidBinding()  // 10 min validity — outside proactive window
      mockGetBinding.mockReturnValue(binding)

      vi.mocked(fetch).mockResolvedValueOnce(makeResponse({ data: 'ok' }))

      const { callEnterprise } = await import('../api')
      await callEnterprise('/api/client/v1/session')

      // Should only have made the original request — no refresh call
      expect(fetch).toHaveBeenCalledOnce()
      const [url] = vi.mocked(fetch).mock.calls[0]
      expect(url).toContain('/session')
    })

    it('throws EnterpriseSessionExpiredError when proactive refresh fails', async () => {
      const binding = makeFreshBinding()
      mockGetBinding.mockReturnValue(binding)

      vi.mocked(fetch).mockResolvedValueOnce(
        makeResponse({ error: 'expired_token' }, 401)  // refresh fails
      )

      const { callEnterprise, EnterpriseSessionExpiredError } = await import('../api')
      await expect(callEnterprise('/api/client/v1/session')).rejects.toBeInstanceOf(EnterpriseSessionExpiredError)
    })
  })

  // ── callEnterprise — reactive refresh (401 from server) ──────────────────

  describe('callEnterprise — reactive refresh on 401', () => {
    it('retries original request after successful refresh on 401', async () => {
      const binding = makeValidBinding()  // token valid — no proactive refresh
      mockGetBinding.mockReturnValue(binding)

      mockBind.mockImplementation(async (updated) => {
        mockGetBinding.mockReturnValue(updated)
      })

      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse({ error: 'unauthenticated' }, 401))  // original → 401
        .mockResolvedValueOnce(makeResponse(NEW_TOKENS))                          // refresh
        .mockResolvedValueOnce(makeResponse({ data: 'secret' }))                 // retry → 200

      const { callEnterprise } = await import('../api')
      const result = await callEnterprise<{ data: string }>('/api/client/v1/resource')

      expect(result).toEqual({ data: 'secret' })
      expect(fetch).toHaveBeenCalledTimes(3)

      // Retry request must use new token
      const retryHeaders = vi.mocked(fetch).mock.calls[2][1]?.headers as Record<string, string>
      expect(retryHeaders?.authorization).toBe('Bearer new-access-token')
    })

    it('throws EnterpriseSessionExpiredError when 401 + refresh fails', async () => {
      const binding = makeValidBinding()
      mockGetBinding.mockReturnValue(binding)

      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse({ error: 'unauthenticated' }, 401))  // original → 401
        .mockResolvedValueOnce(makeResponse({ error: 'expired_token' }, 401))    // refresh fails

      const { callEnterprise, EnterpriseSessionExpiredError } = await import('../api')
      await expect(callEnterprise('/api/client/v1/resource')).rejects.toBeInstanceOf(EnterpriseSessionExpiredError)
    })

    it('throws EnterpriseApiError (not session expired) when retry also returns non-200', async () => {
      const binding = makeValidBinding()
      mockGetBinding.mockReturnValue(binding)

      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse({ error: 'unauthenticated' }, 401))  // original → 401
        .mockResolvedValueOnce(makeResponse(NEW_TOKENS))                          // refresh OK
        .mockResolvedValueOnce(makeResponse({ error: 'not_found' }, 404))        // retry → 404

      const { callEnterprise, EnterpriseApiError } = await import('../api')
      await expect(callEnterprise('/api/client/v1/missing')).rejects.toBeInstanceOf(EnterpriseApiError)
    })

    it('does NOT attempt refresh on 401 when binding has no refreshToken', async () => {
      const legacyBinding = makeValidBinding({ refreshToken: undefined, accessExpiresAt: undefined })
      mockGetBinding.mockReturnValue(legacyBinding)

      vi.mocked(fetch).mockResolvedValueOnce(makeResponse({ error: 'unauthenticated' }, 401))

      const { callEnterprise, EnterpriseApiError } = await import('../api')
      // Should throw EnterpriseApiError 401 directly — no retry
      let caught: unknown
      try {
        await callEnterprise('/api/client/v1/resource')
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(EnterpriseApiError)
      expect((caught as InstanceType<typeof EnterpriseApiError>).status).toBe(401)
      // Only one fetch call (no refresh, no retry)
      expect(fetch).toHaveBeenCalledOnce()
    })
  })

  // ── callEnterprise — single-flight concurrent refresh ────────────────────

  describe('callEnterprise — single-flight: concurrent requests only refresh once', () => {
    it('triggers exactly one refresh call when two requests see an expiring token simultaneously', async () => {
      const binding = makeFreshBinding()
      mockGetBinding.mockReturnValue(binding)

      // Track call order
      const callLog: string[] = []

      // Deferred so both callEnterprise calls can start before the refresh settles
      let resolveRefresh!: (v: Response) => void
      const refreshDone = new Promise<Response>((res) => { resolveRefresh = res })

      mockBind.mockImplementation(async (updated) => {
        mockGetBinding.mockReturnValue(updated)
      })

      vi.mocked(fetch).mockImplementation(async (url: RequestInfo | URL) => {
        const urlStr = String(url)
        if (urlStr.includes('/auth/refresh')) {
          callLog.push('refresh')
          return refreshDone  // holds until we resolve
        }
        callLog.push('request')
        return makeResponse({ ok: true })
      })

      const { callEnterprise } = await import('../api')

      // Launch two concurrent calls — both should hit the expiring-token check
      const p1 = callEnterprise('/api/client/v1/session')
      const p2 = callEnterprise('/api/client/v1/session')

      // Let the event loop tick so both calls enter callEnterprise and reach triggerRefresh
      await Promise.resolve()
      await Promise.resolve()

      // Now resolve the refresh
      resolveRefresh(makeResponse(NEW_TOKENS))

      await Promise.all([p1, p2])

      // Exactly one refresh call, two session calls
      expect(callLog.filter(x => x === 'refresh')).toHaveLength(1)
      expect(callLog.filter(x => x === 'request')).toHaveLength(2)
    })
  })

  // ── boot.ts — legacy binding migration tolerance ──────────────────────────

  describe('boot.ts — legacy binding without refreshToken', () => {
    it('loads old-format binding (no refreshToken, no accessExpiresAt) without error', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true)

      const legacyBinding = {
        serverUrl: 'https://old.acme.com',
        orgId: 'org-old',
        orgName: 'OldCo',
        userId: 'u-old',
        userName: 'Bob',
        userEmail: 'bob@old.com',
        deptId: null,
        roleId: null,
        accessToken: 'legacy-90d-token',
        // No accessExpiresAt, no refreshToken
        boundAt: '2025-01-01T00:00:00Z',
        llmEndpoint: null,
        llmVirtualKey: null,
        llmKeyExpiresAt: null,
      }
      ;(fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(legacyBinding))

      const { loadBinding } = await import('../boot')
      const result = await loadBinding()

      // Should load successfully without crashing
      expect(result).not.toBeNull()
      expect(result?.accessToken).toBe('legacy-90d-token')
      // New fields absent
      expect(result?.refreshToken).toBeUndefined()
      expect(result?.accessExpiresAt).toBeUndefined()
    })

    it('returns null for binding missing required fields (serverUrl / userId / accessToken)', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify({ serverUrl: 'https://x.com' })  // missing userId + accessToken
      )

      const { loadBinding } = await import('../boot')
      const result = await loadBinding()
      expect(result).toBeNull()
    })

    it('loads new-format binding (with refreshToken and accessExpiresAt) correctly', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true)

      const newBinding = {
        serverUrl: 'https://new.acme.com',
        orgId: 'org1',
        orgName: 'Acme',
        userId: 'u1',
        userName: 'Alice',
        userEmail: 'alice@acme.com',
        deptId: null,
        roleId: null,
        accessToken: 'short-lived-jwt',
        accessExpiresAt: '2026-06-26T10:15:00Z',
        refreshToken: 'opaque-refresh-token',
        boundAt: '2026-06-26T10:00:00Z',
        llmEndpoint: null,
        llmVirtualKey: null,
        llmKeyExpiresAt: null,
      }
      ;(fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(newBinding))

      const { loadBinding } = await import('../boot')
      const result = await loadBinding()

      expect(result?.accessToken).toBe('short-lived-jwt')
      expect(result?.refreshToken).toBe('opaque-refresh-token')
      expect(result?.accessExpiresAt).toBe('2026-06-26T10:15:00Z')
    })
  })

  // ── EnterpriseSessionExpiredError shape ───────────────────────────────────

  describe('EnterpriseSessionExpiredError', () => {
    it('carries the underlying cause error', async () => {
      const { EnterpriseSessionExpiredError } = await import('../api')
      const cause = new Error('upstream failure')
      const err = new EnterpriseSessionExpiredError(cause)
      expect(err.name).toBe('EnterpriseSessionExpiredError')
      expect(err.cause).toBe(cause)
    })

    it('works without a cause argument', async () => {
      const { EnterpriseSessionExpiredError } = await import('../api')
      const err = new EnterpriseSessionExpiredError()
      expect(err.message).toContain('re-login')
      expect(err.cause).toBeUndefined()
    })
  })
})
