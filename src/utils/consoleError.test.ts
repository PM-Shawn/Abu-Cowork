import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getTelemetryTargetMock = vi.hoisted(() =>
  vi.fn(() => ({ baseUrl: 'https://console.test', enabled: true })),
)

vi.mock('./deviceId', () => ({ getDeviceId: () => 'device-1' }))
vi.mock('./version', () => ({ APP_VERSION: '1.2.3' }))
vi.mock('./platform', () => ({ getPlatform: () => 'macos' }))
vi.mock('./consoleTelemetryTarget', () => ({
  getTelemetryTarget: () => getTelemetryTargetMock(),
}))

import { reportError } from './consoleError'

describe('reportError privacy boundary', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    getTelemetryTargetMock.mockReturnValue({ baseUrl: 'https://console.test', enabled: true })
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

  it.each(['main_crash', 'renderer_crash', 'sidecar_crash'] as const)(
    'sends %s with the crash classification and no model/status fields',
    (errorType) => {
      reportError(errorType, 'crashed', undefined, undefined, 'renderer process died')

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://console.test/api/error')
      expect(JSON.parse(String(init.body))).toMatchObject({
        errorType,
        errorCode: 'crashed',
        errorMessage: 'renderer process died',
        statusCode: null,
        model: null,
        rawBody: null,
      })
    },
  )

  it.each(['main_crash', 'renderer_crash', 'sidecar_crash'] as const)(
    'never sends %s once telemetry is opted out',
    (errorType) => {
      getTelemetryTargetMock.mockReturnValue({ baseUrl: '', enabled: false })

      reportError(errorType, 'crashed', undefined, undefined, 'renderer process died')

      expect(fetch).not.toHaveBeenCalled()
    },
  )
})
