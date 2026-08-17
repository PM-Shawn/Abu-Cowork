import { getDeviceId } from './deviceId'
import { APP_VERSION } from './version'
import { getPlatform } from './platform'
import { getTelemetryTarget } from './consoleTelemetryTarget'

const MAX_ERROR_MESSAGE_CHARS = 500
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{12,}/g,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/g,
  /\bBearer\s+[a-zA-Z0-9._\-+/=]{8,}/gi,
  /\b(?:token|api[_-]?key|password|secret|authorization)\s*[=:]\s*\S+/gi,
]

function safeErrorMessage(value: string | undefined): string | null {
  if (!value) return null
  let result = value
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[REDACTED]')
  return Array.from(result, (char) => {
    const code = char.charCodeAt(0)
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127 ? '' : char
  }).join('').slice(0, MAX_ERROR_MESSAGE_CHARS)
}

/**
 * `api_error` / `agent_crash` come from the agent loop. The three crash types
 * are process-level deaths: the Electron main process hitting an uncaught
 * exception or unhandled rejection, a renderer process dying (crashed/oom),
 * and the agent sidecar tripping its crash-loop breaker. Ordinary sidecar
 * restarts and caught render errors stay on the local runtime log only.
 */
export type ConsoleErrorType =
  | 'api_error'
  | 'agent_crash'
  | 'main_crash'
  | 'renderer_crash'
  | 'sidecar_crash'

export function reportError(
  errorType: ConsoleErrorType,
  errorCode?: string,
  statusCode?: number,
  model?: string,
  errorMessage?: string,
  _rawBody?: string,
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
      errorMessage: safeErrorMessage(errorMessage),
      // Provider bodies can contain echoed prompts, credentials, proxy pages,
      // or upstream request metadata. Status/errorCode retain the useful
      // classification signal; raw bodies stay local and may only enter a
      // user-initiated diagnostic bundle after its normal scrub pass.
      rawBody: null,
      statusCode: statusCode ?? null,
      model: model ?? null,
      appVersion: APP_VERSION,
      platform: getPlatform() ?? 'unknown',
    }),
  }).catch(() => {})
}
