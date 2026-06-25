// src/core/enterprise/__tests__/heartbeat.test.ts
//
// O5: heartbeat → GET /api/client/v1/session with ETag (If-None-Match).
//   304 Not Modified → preserve existing config, update fetchedAt only.
//   200 OK           → replace config, store new configVersion.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { EnterpriseConfigSnapshot } from '../types'

// ─── Hoisted helpers ──────────────────────────────────────────────────────────

const mockCallEnterprise = vi.hoisted(() => vi.fn())

// We need EnterpriseApiError to be the same class that heartbeat.ts sees after
// the module is mocked, so both the test (for throwing) and the source (for
// instanceof checks) reference the identical constructor.
const MockEnterpriseApiError = vi.hoisted(() => {
  class ErrClass extends Error {
    readonly status: number
    readonly body: unknown
    constructor(status: number, body: unknown) {
      super(`HTTP ${status}`)
      this.name = 'EnterpriseApiError'
      this.status = status
      this.body = body
    }
  }
  return ErrClass
})

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/core/enterprise/api', () => ({
  callEnterprise: mockCallEnterprise,
  EnterpriseApiError: MockEnterpriseApiError,
}))

const mockSetConfig = vi.hoisted(() => vi.fn())
const mockSetOffline = vi.hoisted(() => vi.fn())
const mockGetState = vi.hoisted(() => vi.fn())

vi.mock('@/stores/enterpriseStore', () => ({
  useEnterpriseStore: { getState: mockGetState },
  getBinding: vi.fn(),
  isEnterprise: vi.fn(),
}))

// ─── Import after mocks ───────────────────────────────────────────────────────

import { _heartbeatTickForTesting } from '../heartbeat'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EXISTING_CONFIG: EnterpriseConfigSnapshot = {
  brand: { name: 'Acme', logoUrl: null, primaryColor: null },
  defaultSoul: null,
  policyDefaults: {},
  modules: ['core'],
  licenseStatus: 'valid',
  serverTime: '2026-06-26T09:00:00Z',
  fetchedAt: 1_000_000,
  configVersion: 'sha256-abcd1234',
  telemetryEnabled: true,
}

const SESSION_RESPONSE_200 = {
  configVersion: 'sha256-efgh5678',
  user: { id: 'u1', email: 'alice@acme.com', name: 'Alice', role: 'member', status: 'active' },
  org: { id: 'org1', name: 'Acme Corp', plan: 'enterprise' },
  policy: { enabledLoginMethods: ['sso'], registrationMode: 'open_approval', telemetryEnabled: true },
  branding: { name: 'Acme Abu', logoUrl: 'https://acme.com/logo.png', primaryColor: '#1677FF' },
  llm: { gatewayUrl: 'https://llm.acme.com', virtualKey: 'vk-xxx', models: ['gpt-4o'], defaultModel: 'gpt-4o' },
  modules: { skills: true, mcp: true, kb: false },
  license: { plan: 'enterprise', expiresAt: '2027-06-26T00:00:00Z', seats: 100, usedSeats: 42 },
  serverTime: '2026-06-26T10:00:00Z',
}

function makeStoreState(
  overrides: Partial<{ config: EnterpriseConfigSnapshot | null; mode: 'enterprise' | 'offline' | 'personal' }> = {},
) {
  const { config = EXISTING_CONFIG, mode = 'enterprise' } = overrides
  if (mode === 'personal') {
    return { mode: { kind: 'personal' as const }, setConfig: mockSetConfig, setOffline: mockSetOffline }
  }
  if (mode === 'offline') {
    return {
      mode: { kind: 'offline' as const, binding: { serverUrl: 'https://abu.acme.com' }, lastConfig: config, reason: 'test' },
      setConfig: mockSetConfig,
      setOffline: mockSetOffline,
    }
  }
  return {
    mode: { kind: 'enterprise' as const, binding: { serverUrl: 'https://abu.acme.com' }, config },
    setConfig: mockSetConfig,
    setOffline: mockSetOffline,
  }
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── 200 OK path ──────────────────────────────────────────────────────────────

describe('session 200 OK', () => {
  it('updates config with new configVersion', async () => {
    mockGetState.mockReturnValue(makeStoreState({ config: EXISTING_CONFIG }))
    mockCallEnterprise.mockResolvedValueOnce(SESSION_RESPONSE_200)

    await _heartbeatTickForTesting()

    expect(mockSetConfig).toHaveBeenCalledOnce()
    const snap = mockSetConfig.mock.calls[0][0] as EnterpriseConfigSnapshot
    expect(snap.configVersion).toBe('sha256-efgh5678')
  })

  it('sets telemetryEnabled from policy', async () => {
    mockGetState.mockReturnValue(makeStoreState({ config: EXISTING_CONFIG }))
    mockCallEnterprise.mockResolvedValueOnce({ ...SESSION_RESPONSE_200, policy: { ...SESSION_RESPONSE_200.policy, telemetryEnabled: false } })

    await _heartbeatTickForTesting()

    const snap = mockSetConfig.mock.calls[0][0] as EnterpriseConfigSnapshot
    expect(snap.telemetryEnabled).toBe(false)
  })

  it('maps branding fields into brand', async () => {
    mockGetState.mockReturnValue(makeStoreState({ config: EXISTING_CONFIG }))
    mockCallEnterprise.mockResolvedValueOnce(SESSION_RESPONSE_200)

    await _heartbeatTickForTesting()

    const snap = mockSetConfig.mock.calls[0][0] as EnterpriseConfigSnapshot
    expect(snap.brand.name).toBe('Acme Abu')
    expect(snap.brand.primaryColor).toBe('#1677FF')
  })

  it('sends If-None-Match header from existing configVersion', async () => {
    mockGetState.mockReturnValue(makeStoreState({ config: EXISTING_CONFIG }))
    mockCallEnterprise.mockResolvedValueOnce(SESSION_RESPONSE_200)

    await _heartbeatTickForTesting()

    expect(mockCallEnterprise).toHaveBeenCalledWith(
      '/api/client/v1/session',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'if-none-match': 'sha256-abcd1234' }),
      }),
    )
  })

  it('omits If-None-Match when no prior configVersion exists', async () => {
    const configWithoutVersion = { ...EXISTING_CONFIG, configVersion: undefined }
    mockGetState.mockReturnValue(makeStoreState({ config: configWithoutVersion }))
    mockCallEnterprise.mockResolvedValueOnce(SESSION_RESPONSE_200)

    await _heartbeatTickForTesting()

    const [, init] = mockCallEnterprise.mock.calls[0] as [string, { headers?: Record<string, string> }]
    expect(init.headers?.['if-none-match']).toBeUndefined()
  })
})

// ─── 304 Not Modified path ────────────────────────────────────────────────────

describe('session 304 Not Modified', () => {
  it('preserves existing config (setConfig called with same configVersion)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)

    mockGetState.mockReturnValue(makeStoreState({ config: EXISTING_CONFIG }))
    mockCallEnterprise.mockRejectedValueOnce(new MockEnterpriseApiError(304, {}))

    await _heartbeatTickForTesting()

    expect(mockSetConfig).toHaveBeenCalledOnce()
    const snap = mockSetConfig.mock.calls[0][0] as EnterpriseConfigSnapshot
    // configVersion unchanged
    expect(snap.configVersion).toBe('sha256-abcd1234')
    // brand preserved
    expect(snap.brand.name).toBe('Acme')
  })

  it('bumps fetchedAt to current time', async () => {
    vi.useFakeTimers()
    const now = 9_999_000
    vi.setSystemTime(now)

    mockGetState.mockReturnValue(makeStoreState({ config: EXISTING_CONFIG }))
    mockCallEnterprise.mockRejectedValueOnce(new MockEnterpriseApiError(304, {}))

    await _heartbeatTickForTesting()

    const snap = mockSetConfig.mock.calls[0][0] as EnterpriseConfigSnapshot
    expect(snap.fetchedAt).toBe(now)
  })

  it('does nothing (no setConfig) when there is no existing config', async () => {
    mockGetState.mockReturnValue(makeStoreState({ config: null }))
    mockCallEnterprise.mockRejectedValueOnce(new MockEnterpriseApiError(304, {}))

    await _heartbeatTickForTesting()

    expect(mockSetConfig).not.toHaveBeenCalled()
  })

  it('does not call setOffline on 304', async () => {
    mockGetState.mockReturnValue(makeStoreState({ config: EXISTING_CONFIG }))
    mockCallEnterprise.mockRejectedValueOnce(new MockEnterpriseApiError(304, {}))

    await _heartbeatTickForTesting()

    expect(mockSetOffline).not.toHaveBeenCalled()
  })
})

// ─── Error paths ──────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('calls setOffline on 401', async () => {
    mockGetState.mockReturnValue(makeStoreState())
    mockCallEnterprise.mockRejectedValueOnce(new MockEnterpriseApiError(401, { error: 'unauthenticated' }))

    await _heartbeatTickForTesting()

    expect(mockSetOffline).toHaveBeenCalledWith('token rejected')
  })

  it('calls setOffline on 403', async () => {
    mockGetState.mockReturnValue(makeStoreState())
    mockCallEnterprise.mockRejectedValueOnce(new MockEnterpriseApiError(403, { error: 'account_suspended' }))

    await _heartbeatTickForTesting()

    expect(mockSetOffline).toHaveBeenCalledWith('token rejected')
  })

  it('calls setOffline with error message on generic network error', async () => {
    mockGetState.mockReturnValue(makeStoreState())
    mockCallEnterprise.mockRejectedValueOnce(new Error('Failed to fetch'))

    await _heartbeatTickForTesting()

    expect(mockSetOffline).toHaveBeenCalledWith('Failed to fetch')
  })
})
