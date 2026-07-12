// src/utils/consoleTelemetryTarget.test.ts
//
// O5: telemetry URL routing helper.
// Three modes:
//   1. Personal / no binding          → VITE_CONSOLE_URL (https://console-test.local in tests)
//   2. Enterprise, telemetryEnabled   → binding.serverUrl
//   3. Enterprise, telemetry disabled → { enabled: false }
//   4. Enterprise, no config yet      → VITE_CONSOLE_URL fallback

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EnterpriseConfigSnapshot } from '@/core/enterprise/types'

// ─── Mock enterpriseStore ─────────────────────────────────────────────────────

const mockGetState = vi.hoisted(() => vi.fn())

vi.mock('@/stores/enterpriseStore', () => ({
  useEnterpriseStore: { getState: mockGetState },
  getBinding: vi.fn(),
  isEnterprise: vi.fn(),
}))

// ─── Import after mocks ───────────────────────────────────────────────────────

import { getTelemetryTarget } from './consoleTelemetryTarget'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SERVER_URL = 'https://abu.acme.com'

const CONFIG_ENABLED: EnterpriseConfigSnapshot = {
  brand: { name: 'Acme', logoUrl: null, primaryColor: null },
  defaultSoul: null,
  policyDefaults: {},
  modules: ['core'],
  licenseStatus: 'valid',
  serverTime: '2026-06-26T10:00:00Z',
  fetchedAt: 1_000_000,
  configVersion: 'sha256-abcd',
  telemetryEnabled: true,
}

const CONFIG_DISABLED: EnterpriseConfigSnapshot = {
  ...CONFIG_ENABLED,
  telemetryEnabled: false,
}

function makePersonalMode() {
  return { mode: { kind: 'personal' as const } }
}

function makeEnterpriseMode(config: EnterpriseConfigSnapshot | null) {
  return {
    mode: {
      kind: 'enterprise' as const,
      binding: { serverUrl: SERVER_URL },
      config,
    },
  }
}

function makeOfflineMode(lastConfig: EnterpriseConfigSnapshot | null) {
  return {
    mode: {
      kind: 'offline' as const,
      binding: { serverUrl: SERVER_URL },
      lastConfig,
      reason: 'network error',
    },
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getTelemetryTarget', () => {
  describe('personal mode', () => {
    it('returns VITE_CONSOLE_URL as baseUrl and enabled=true', () => {
      mockGetState.mockReturnValue(makePersonalMode())
      const target = getTelemetryTarget()
      // vitest.config.ts sets VITE_CONSOLE_URL = 'https://console-test.local'
      expect(target.enabled).toBe(true)
      expect(target.baseUrl).toBe('https://console-test.local')
    })
  })

  describe('enterprise mode — connected with config', () => {
    it('returns serverUrl when telemetryEnabled is true', () => {
      mockGetState.mockReturnValue(makeEnterpriseMode(CONFIG_ENABLED))
      const target = getTelemetryTarget()
      expect(target.enabled).toBe(true)
      expect(target.baseUrl).toBe(SERVER_URL)
    })

    it('returns enabled=false when telemetryEnabled is false', () => {
      mockGetState.mockReturnValue(makeEnterpriseMode(CONFIG_DISABLED))
      const target = getTelemetryTarget()
      expect(target.enabled).toBe(false)
    })

    it('defaults to enabled when telemetryEnabled is undefined', () => {
      const configNoFlag = { ...CONFIG_ENABLED, telemetryEnabled: undefined }
      mockGetState.mockReturnValue(makeEnterpriseMode(configNoFlag))
      const target = getTelemetryTarget()
      expect(target.enabled).toBe(true)
      expect(target.baseUrl).toBe(SERVER_URL)
    })

    it('strips trailing slash from serverUrl', () => {
      mockGetState.mockReturnValue(makeEnterpriseMode({
        ...CONFIG_ENABLED,
      }))
      // Override binding to have trailing slash
      mockGetState.mockReturnValue({
        mode: { kind: 'enterprise', binding: { serverUrl: 'https://abu.acme.com/' }, config: CONFIG_ENABLED },
      })
      const target = getTelemetryTarget()
      expect(target.baseUrl).toBe('https://abu.acme.com')
    })
  })

  describe('enterprise mode — no config snapshot yet', () => {
    it('falls back to VITE_CONSOLE_URL when config is null', () => {
      mockGetState.mockReturnValue(makeEnterpriseMode(null))
      const target = getTelemetryTarget()
      expect(target.enabled).toBe(true)
      expect(target.baseUrl).toBe('https://console-test.local')
    })
  })

  describe('offline mode — with last config', () => {
    it('returns serverUrl when last config has telemetryEnabled true', () => {
      mockGetState.mockReturnValue(makeOfflineMode(CONFIG_ENABLED))
      const target = getTelemetryTarget()
      expect(target.enabled).toBe(true)
      expect(target.baseUrl).toBe(SERVER_URL)
    })

    it('returns enabled=false when last config has telemetryEnabled false', () => {
      mockGetState.mockReturnValue(makeOfflineMode(CONFIG_DISABLED))
      const target = getTelemetryTarget()
      expect(target.enabled).toBe(false)
    })
  })

  describe('offline mode — no last config', () => {
    it('falls back to VITE_CONSOLE_URL when lastConfig is null', () => {
      mockGetState.mockReturnValue(makeOfflineMode(null))
      const target = getTelemetryTarget()
      expect(target.enabled).toBe(true)
      expect(target.baseUrl).toBe('https://console-test.local')
    })
  })
})
