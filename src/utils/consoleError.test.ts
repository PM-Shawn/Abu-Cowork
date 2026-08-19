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

  // RB-05. The audit intercepted this payload and found a real user path in
  // it, next to a stable device id. Assert on the wire body, not on the
  // scrub helper, so any future field added to the payload has to face this
  // test too.
  it('sends no user path, url, or business text in the wire payload', () => {
    reportError(
      'main_crash',
      'Error',
      undefined,
      undefined,
      "Failed reading /Users/alice/SecretClient/客户方案.txt from https://acme.internal/x",
    )

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    const raw = String(init.body)
    for (const leaked of ['alice', 'SecretClient', '客户方案', 'acme.internal']) {
      expect(raw, leaked).not.toContain(leaked)
    }

    const body = JSON.parse(raw) as Record<string, unknown>
    // What survives is the shape plus a grouping key — still enough to say
    // what broke and how often, which is what the remote report is for.
    expect(String(body.errorMessage)).toContain('Failed reading')
    expect(body.fingerprint).toEqual(expect.any(String))
    expect(body.errorType).toBe('main_crash')
    expect(body.errorCode).toBe('Error')
  })

  it('groups two machines hitting the same failure under one fingerprint', () => {
    reportError('renderer_crash', 'Error', undefined, undefined, "ENOENT: open '/Users/alice/a.txt'")
    reportError('renderer_crash', 'Error', undefined, undefined, "ENOENT: open '/Users/bob/b.txt'")

    const bodies = vi.mocked(fetch).mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    )
    expect(bodies[0].fingerprint).toBe(bodies[1].fingerprint)
  })

  it.each(['main_crash', 'renderer_crash', 'sidecar_crash'] as const)(
    'never sends %s once telemetry is opted out',
    (errorType) => {
      getTelemetryTargetMock.mockReturnValue({ baseUrl: '', enabled: false })

      reportError(errorType, 'crashed', undefined, undefined, 'renderer process died')

      expect(fetch).not.toHaveBeenCalled()
    },
  )
})
