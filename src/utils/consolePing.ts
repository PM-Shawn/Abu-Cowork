import { getDeviceId } from './deviceId'
import { APP_VERSION } from './version'
import { getPlatform } from './platform'

const CONSOLE_URL = import.meta.env.VITE_CONSOLE_URL as string | undefined

export function sendConsolePing(): void {
  if (!CONSOLE_URL) return

  const payload = {
    deviceId: getDeviceId(),
    appVersion: APP_VERSION,
    platform: getPlatform() ?? 'unknown',
    osVersion: navigator.userAgent,
  }

  fetch(`${CONSOLE_URL}/api/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {
    // fire-and-forget，失败静默
  })
}
