// src/utils/consoleTelemetryTarget.ts
//
// Resolves the telemetry base URL and enabled flag for the current mode:
//
//   Enterprise (connected, config present, telemetryEnabled !== false)
//     → { baseUrl: binding.serverUrl, enabled: true }
//
//   Enterprise (connected / offline, config present, telemetryEnabled === false)
//     → { baseUrl: '', enabled: false }   — caller must skip the request
//
//   Personal mode, OR enterprise/offline with NO config snapshot yet
//     → falls back to VITE_CONSOLE_URL behaviour (same as before enterprise support)
//
// This is intentionally a function (not a module-level const) so it reflects
// the live store state at the time of each telemetry call.
import { useEnterpriseStore } from '@/stores/enterpriseStore'

const CONSOLE_URL = import.meta.env?.VITE_CONSOLE_URL as string | undefined

export interface TelemetryTarget {
  baseUrl: string
  enabled: boolean
}

export function getTelemetryTarget(): TelemetryTarget {
  const mode = useEnterpriseStore.getState().mode

  // Enterprise (connected) with a fully-fetched config snapshot
  if (mode.kind === 'enterprise' && mode.config != null) {
    if (mode.config.telemetryEnabled === false) return { baseUrl: '', enabled: false }
    return { baseUrl: mode.binding.serverUrl.replace(/\/$/, ''), enabled: true }
  }

  // Offline mode with last-known config snapshot
  if (mode.kind === 'offline' && mode.lastConfig != null) {
    if (mode.lastConfig.telemetryEnabled === false) return { baseUrl: '', enabled: false }
    return { baseUrl: mode.binding.serverUrl.replace(/\/$/, ''), enabled: true }
  }

  // Personal mode, or enterprise/offline without any config snapshot yet:
  // preserve the original VITE_CONSOLE_URL behaviour.
  if (!CONSOLE_URL) return { baseUrl: '', enabled: false }
  return { baseUrl: CONSOLE_URL.replace(/\/$/, ''), enabled: true }
}
