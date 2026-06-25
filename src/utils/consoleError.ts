import { getDeviceId } from './deviceId'
import { APP_VERSION } from './version'
import { getPlatform } from './platform'
import { getTelemetryTarget } from './consoleTelemetryTarget'

export function reportError(
  errorType: 'api_error' | 'agent_crash',
  errorCode?: string,
  statusCode?: number,
  model?: string,
  errorMessage?: string,
  rawBody?: string,
): void {
  const { baseUrl, enabled } = getTelemetryTarget()
  if (!enabled) return

  fetch(`${baseUrl}/api/error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: getDeviceId(),
      errorType,
      errorCode: errorCode ?? null,
      errorMessage: errorMessage ?? null,
      rawBody: rawBody ?? null,
      statusCode: statusCode ?? null,
      model: model ?? null,
      appVersion: APP_VERSION,
      platform: getPlatform() ?? 'unknown',
    }),
  }).catch(() => {})
}
