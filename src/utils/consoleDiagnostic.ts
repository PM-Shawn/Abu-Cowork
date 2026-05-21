import { getDeviceId } from './deviceId'
import { APP_VERSION } from './version'
import { getPlatform } from './platform'
import { useDiagnosticStore, getOverallStatus } from '@/stores/diagnosticStore'

const CONSOLE_URL = import.meta.env.VITE_CONSOLE_URL as string | undefined

export async function uploadDiagnosticBundle(bytes: Uint8Array, filename: string): Promise<void> {
  if (!CONSOLE_URL) throw new Error('no_console_url')

  const formData = new FormData()
  formData.append('file', new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' }), filename)
  formData.append('deviceId', getDeviceId())
  formData.append('appVersion', APP_VERSION)
  formData.append('platform', getPlatform() ?? 'unknown')

  const res = await fetch(`${CONSOLE_URL}/api/diagnostics/upload`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`upload_failed:${res.status} ${text}`)
  }
}

export function pushDiagnosticSnapshot(): void {
  if (!CONSOLE_URL) return

  const state = useDiagnosticStore.getState()
  const results = Object.values(state.results)
  if (results.length === 0) return

  const overall = getOverallStatus(state)
  // Don't push while checks are still running
  if (overall === 'checking') return

  fetch(`${CONSOLE_URL}/api/diagnostic`, {
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
