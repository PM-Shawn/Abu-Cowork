// src/core/enterprise/heartbeat.ts
import { callEnterprise, EnterpriseApiError } from './api'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import type { EnterpriseConfigSnapshot } from './types'

const INTERVAL_MS = 5 * 60 * 1000

let timer: number | null = null

export function startHeartbeat() {
  if (timer != null) return
  const tick = async () => {
    try {
      const resp = await callEnterprise<Record<string, unknown>>('/api/client/heartbeat', { method: 'POST' })
      const brand = resp.brand as Record<string, string | null> | undefined
      const snap: EnterpriseConfigSnapshot = {
        brand: {
          name: (brand?.name as string | undefined) ?? '',
          logoUrl: (brand?.logoUrl as string | null | undefined) ?? null,
          primaryColor: (brand?.primaryColor as string | null | undefined) ?? null,
        },
        defaultSoul: (resp.defaultSoul as string | null | undefined) ?? null,
        policyDefaults: (resp.policyDefaults as Record<string, unknown> | undefined) ?? {},
        modules: (resp.modules as string[] | undefined) ?? ['core'],
        licenseStatus: (resp.licenseStatus as EnterpriseConfigSnapshot['licenseStatus'] | undefined) ?? 'missing',
        serverTime: (resp.serverTime as string | undefined) ?? new Date().toISOString(),
        fetchedAt: Date.now(),
      }
      useEnterpriseStore.getState().setConfig(snap)
    } catch (e) {
      if (e instanceof EnterpriseApiError && (e.status === 401 || e.status === 403)) {
        // token expired / revoked — go offline; UI prompts re-bind
        useEnterpriseStore.getState().setOffline('token rejected')
      } else {
        useEnterpriseStore.getState().setOffline((e as Error).message)
      }
    }
  }
  void tick()  // immediate
  timer = window.setInterval(tick, INTERVAL_MS) as unknown as number
}

export function stopHeartbeat() {
  if (timer != null) { window.clearInterval(timer); timer = null }
}
