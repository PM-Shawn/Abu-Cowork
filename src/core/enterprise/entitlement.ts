import { useEnterpriseStore } from '@/stores/enterpriseStore'
import {
  isEnterpriseEntitlementActive,
  snapshotEnterpriseEntitlement,
  type ClientEnterpriseModule,
} from './entitlement-state'

export type { ClientEnterpriseModule } from './entitlement-state'

/**
 * Local enterprise capabilities are usable only after a live session response
 * confirms the module. Cached/offline state is deliberately fail-closed.
 */
export function isEnterpriseModuleActive(module: ClientEnterpriseModule): boolean {
  return isEnterpriseEntitlementActive(
    snapshotEnterpriseEntitlement(useEnterpriseStore.getState().mode),
    module,
  )
}

/** Reactive variant for enterprise UI surfaces. */
export function useEnterpriseModuleActive(module: ClientEnterpriseModule): boolean {
  return useEnterpriseStore(state => isEnterpriseEntitlementActive(
    snapshotEnterpriseEntitlement(state.mode),
    module,
  ))
}
