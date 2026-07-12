// src/core/enterprise/heartbeat.ts
//
// Polls GET /api/client/v1/session every 5 minutes.
// Sends If-None-Match: <configVersion> so the server can reply 304 when nothing changed.
// On 304: preserve existing snapshot (only bump fetchedAt).
// On 200: replace snapshot, persist new configVersion + telemetryEnabled.
import { callEnterprise, EnterpriseApiError } from './api'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import type { EnterpriseConfigSnapshot } from './types'

const INTERVAL_MS = 5 * 60 * 1000

let timer: number | null = null

function getCurrentConfig(): EnterpriseConfigSnapshot | null {
  const m = useEnterpriseStore.getState().mode
  if (m.kind === 'enterprise') return m.config
  if (m.kind === 'offline') return m.lastConfig
  return null
}

async function tick(): Promise<void> {
  try {
    const lastConfig = getCurrentConfig()
    const extraHeaders: Record<string, string> = {}
    if (lastConfig?.configVersion) {
      extraHeaders['if-none-match'] = lastConfig.configVersion
    }

    const resp = await callEnterprise<Record<string, unknown>>(
      '/api/client/v1/session',
      { method: 'GET', headers: extraHeaders },
    )

    // 200 OK — update config snapshot from session response
    const branding = resp.branding as Record<string, string | null> | undefined
    const policy = resp.policy as Record<string, unknown> | undefined
    const modules = resp.modules as Record<string, boolean> | undefined

    const snap: EnterpriseConfigSnapshot = {
      brand: {
        name:         (branding?.name as string | undefined) ?? '',
        logoUrl:      (branding?.logoUrl as string | null | undefined) ?? null,
        primaryColor: (branding?.primaryColor as string | null | undefined) ?? null,
      },
      defaultSoul:    (resp.defaultSoul as string | null | undefined) ?? null,
      policyDefaults: (policy as Record<string, unknown> | undefined) ?? {},
      modules:        modules
        ? Object.keys(modules).filter(k => modules[k] === true)
        : ['core'],
      licenseStatus:  'valid',
      serverTime:     (resp.serverTime as string | undefined) ?? new Date().toISOString(),
      fetchedAt:      Date.now(),
      configVersion:  (resp.configVersion as string | undefined) ?? undefined,
      telemetryEnabled: (policy?.telemetryEnabled as boolean | undefined) ?? true,
    }
    useEnterpriseStore.getState().setConfig(snap)
  } catch (e) {
    if (e instanceof EnterpriseApiError && e.status === 304) {
      // 304 Not Modified — server config unchanged.
      // Preserve the existing snapshot but refresh the fetchedAt timestamp.
      const existing = getCurrentConfig()
      if (existing) {
        useEnterpriseStore.getState().setConfig({ ...existing, fetchedAt: Date.now() })
      }
      return
    }
    if (e instanceof EnterpriseApiError && (e.status === 401 || e.status === 403)) {
      // token expired / revoked — go offline; UI prompts re-bind
      useEnterpriseStore.getState().setOffline('token rejected')
    } else {
      useEnterpriseStore.getState().setOffline((e as Error).message)
    }
  }
}

export function startHeartbeat(): void {
  if (timer != null) return
  void tick()  // immediate first poll
  timer = window.setInterval(() => { void tick() }, INTERVAL_MS) as unknown as number
}

export function stopHeartbeat(): void {
  if (timer != null) { window.clearInterval(timer); timer = null }
}

/** @internal — exposed for unit-testing only; do not call from production code. */
export function _heartbeatTickForTesting(): Promise<void> {
  return tick()
}
