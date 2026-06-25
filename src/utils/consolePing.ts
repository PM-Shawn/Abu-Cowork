import { getDeviceId } from './deviceId'
import { APP_VERSION } from './version'
import { getPlatform } from './platform'
import { getTelemetryTarget } from './consoleTelemetryTarget'

export function sendConsolePing(): void {
  const { baseUrl, enabled } = getTelemetryTarget()
  if (!enabled) return

  const payload = {
    deviceId: getDeviceId(),
    appVersion: APP_VERSION,
    platform: getPlatform() ?? 'unknown',
    osVersion: navigator.userAgent,
  }

  fetch(`${baseUrl}/api/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {
    // fire-and-forget，失败静默
  })
}
