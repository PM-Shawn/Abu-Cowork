import {
  FAIL_CLOSED_ENTERPRISE_ENTITLEMENT,
  isEnterpriseEntitlementActive,
  type ClientEnterpriseModule,
  type EnterpriseEntitlementSnapshot,
} from '@/core/enterprise/entitlement-state'

let current: EnterpriseEntitlementSnapshot = FAIL_CLOSED_ENTERPRISE_ENTITLEMENT

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Apply an untrusted shell push. Malformed state always revokes access. */
export function applyEnterpriseEntitlementSnapshot(value: unknown): void {
  if (!isRecord(value)
    || !['personal', 'enterprise', 'offline'].includes(String(value.mode))
    || (value.licenseStatus !== null && typeof value.licenseStatus !== 'string')
    || (value.licenseExpiresAt !== null && typeof value.licenseExpiresAt !== 'string')
    || !Array.isArray(value.modules)
    || value.modules.some(module => typeof module !== 'string')) {
    current = FAIL_CLOSED_ENTERPRISE_ENTITLEMENT
    return
  }
  current = {
    mode: value.mode as EnterpriseEntitlementSnapshot['mode'],
    licenseStatus: value.licenseStatus as string | null,
    licenseExpiresAt: value.licenseExpiresAt as string | null,
    modules: [...value.modules] as string[],
  }
}

export function isEnterpriseModuleActive(module: ClientEnterpriseModule): boolean {
  return isEnterpriseEntitlementActive(current, module)
}

/** Test-only reset; production starts fail-closed without a shell push. */
export function __resetEnterpriseEntitlementMirror(): void {
  current = FAIL_CLOSED_ENTERPRISE_ENTITLEMENT
}
