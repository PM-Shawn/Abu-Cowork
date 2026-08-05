import type { EnterpriseMode } from './types'

export type ClientEnterpriseModule = 'skills' | 'mcp' | 'kb'

export interface EnterpriseEntitlementSnapshot {
  mode: 'personal' | 'enterprise' | 'offline'
  licenseStatus: string | null
  licenseExpiresAt: string | null
  modules: string[]
}

export const FAIL_CLOSED_ENTERPRISE_ENTITLEMENT: EnterpriseEntitlementSnapshot = {
  mode: 'personal',
  licenseStatus: null,
  licenseExpiresAt: null,
  modules: [],
}

/** Wire-safe projection: never includes binding tokens or organization PII. */
export function snapshotEnterpriseEntitlement(mode: EnterpriseMode): EnterpriseEntitlementSnapshot {
  if (mode.kind !== 'enterprise' || !mode.config) {
    return {
      mode: mode.kind,
      licenseStatus: null,
      licenseExpiresAt: null,
      modules: [],
    }
  }
  return {
    mode: 'enterprise',
    licenseStatus: mode.config.licenseStatus,
    licenseExpiresAt: mode.config.licenseExpiresAt ?? null,
    modules: [...mode.config.modules],
  }
}

export function isEnterpriseEntitlementActive(
  snapshot: EnterpriseEntitlementSnapshot,
  module: ClientEnterpriseModule,
  now = Date.now(),
): boolean {
  const expiresAt = snapshot.licenseExpiresAt
  return snapshot.mode === 'enterprise'
    && snapshot.licenseStatus === 'valid'
    && typeof expiresAt === 'string'
    && Number.isFinite(Date.parse(expiresAt))
    && Date.parse(expiresAt) > now
    && snapshot.modules.includes(module)
}
