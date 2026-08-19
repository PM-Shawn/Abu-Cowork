import { getDeviceId } from './deviceId'
import { APP_VERSION } from './version'
import { getPlatform } from './platform'
import { getTelemetryTarget } from './consoleTelemetryTarget'
import { normalizeErrorMessage, errorFingerprint } from './errorTelemetryScrub'

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

  // Shape, not content — see errorTelemetryScrub.ts. The raw message stays
  // local (runtime-observability log + diagnostic bundle); what leaves the
  // machine is the skeleton plus a grouping key derived from it.
  const safeMessage = normalizeErrorMessage(errorMessage)

  fetch(`${baseUrl}/api/error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: getDeviceId(),
      errorType,
      errorCode: errorCode ?? null,
      errorMessage: safeMessage,
      // Stable across machines for the same failure, so a new error is
      // countable ("this shape, 240 times, all Windows 0.40.0") without the
      // free text that used to be the only way to tell two errors apart.
      fingerprint: errorFingerprint(safeMessage),
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
