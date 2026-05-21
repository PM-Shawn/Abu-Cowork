import { getDeviceId } from './deviceId'
import { APP_VERSION } from './version'
import { getPlatform } from './platform'

const CONSOLE_URL = import.meta.env.VITE_CONSOLE_URL as string | undefined

export function reportError(
  errorType: 'api_error' | 'agent_crash',
  errorCode?: string,
  statusCode?: number,
): void {
  if (!CONSOLE_URL) return

  fetch(`${CONSOLE_URL}/api/error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: getDeviceId(),
      errorType,
      errorCode: errorCode ?? null,
      statusCode: statusCode ?? null,
      appVersion: APP_VERSION,
      platform: getPlatform() ?? 'unknown',
    }),
  }).catch(() => {})
}
