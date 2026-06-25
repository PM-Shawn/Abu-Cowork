import { getDeviceId } from './deviceId'
import { APP_VERSION } from './version'
import { getPlatform } from './platform'
import { useDiagnosticStore, getOverallStatus } from '@/stores/diagnosticStore'
import { getTelemetryTarget } from './consoleTelemetryTarget'

export async function uploadDiagnosticBundle(bytes: Uint8Array, filename: string): Promise<void> {
  const { baseUrl, enabled } = getTelemetryTarget()
  if (!enabled) throw new Error('no_console_url')

  const formData = new FormData()
  formData.append('file', new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' }), filename)
  formData.append('deviceId', getDeviceId())
  formData.append('appVersion', APP_VERSION)
  formData.append('platform', getPlatform() ?? 'unknown')

  // AbortSignal.timeout() requires Safari 16.4+; use AbortController for broader macOS 12 compat
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/diagnostics/upload`, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`upload_failed:${res.status} ${text}`)
  }
}

export function pushDiagnosticSnapshot(): void {
  const { baseUrl, enabled } = getTelemetryTarget()
  if (!enabled) return

  const state = useDiagnosticStore.getState()
  const results = Object.values(state.results)
  if (results.length === 0) return

  const overall = getOverallStatus(state)
  // Don't push while checks are still running
  if (overall === 'checking') return

  fetch(`${baseUrl}/api/diagnostic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId:   getDeviceId(),
      appVersion: APP_VERSION,
      platform:   getPlatform() ?? 'unknown',
      overall,
      results,
      takenAt:    state.lastCheckedAt,
    }),
  }).catch(() => {})
}
