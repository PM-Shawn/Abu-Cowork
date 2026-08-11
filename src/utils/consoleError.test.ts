import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./deviceId', () => ({ getDeviceId: () => 'device-1' }))
vi.mock('./version', () => ({ APP_VERSION: '1.2.3' }))
vi.mock('./platform', () => ({ getPlatform: () => 'macos' }))
vi.mock('./consoleTelemetryTarget', () => ({
  getTelemetryTarget: () => ({ baseUrl: 'https://console.test', enabled: true }),
}))

import { reportError } from './consoleError'

describe('reportError privacy boundary', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('never uploads a provider raw body and redacts secrets from the bounded message', () => {
    const secret = `sk-${'a'.repeat(32)}`
    reportError(
      'api_error',
      'rate_limited',
      429,
      'model-a',
      `Bearer abcdefghijklmnop failed with ${secret} ${'x'.repeat(800)}`,
      `private prompt and ${secret}`,
    )

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.rawBody).toBeNull()
    expect(String(body.errorMessage)).not.toContain(secret)
    expect(String(body.errorMessage)).not.toContain('abcdefghijklmnop')
    expect(String(body.errorMessage)).toContain('[REDACTED]')
    expect(String(body.errorMessage).length).toBeLessThanOrEqual(500)
  })
})
