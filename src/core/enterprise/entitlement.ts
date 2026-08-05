import { useEnterpriseStore } from '@/stores/enterpriseStore'

export type ClientEnterpriseModule = 'skills' | 'mcp' | 'kb'

/**
 * Local enterprise capabilities are usable only after a live session response
 * confirms the module. Cached/offline state is deliberately fail-closed.
 */
export function isEnterpriseModuleActive(module: ClientEnterpriseModule): boolean {
  const mode = useEnterpriseStore.getState().mode
  const expiresAt = mode.kind === 'enterprise' ? mode.config?.licenseExpiresAt : null
  return mode.kind === 'enterprise'
    && mode.config?.licenseStatus === 'valid'
    && typeof expiresAt === 'string'
    && Number.isFinite(Date.parse(expiresAt))
    && Date.parse(expiresAt) > Date.now()
    && mode.config.modules.includes(module)
}

/** Reactive variant for enterprise UI surfaces. */
export function useEnterpriseModuleActive(module: ClientEnterpriseModule): boolean {
  return useEnterpriseStore(state => {
    const mode = state.mode
    const expiresAt = mode.kind === 'enterprise' ? mode.config?.licenseExpiresAt : null
    return mode.kind === 'enterprise'
      && mode.config?.licenseStatus === 'valid'
      && typeof expiresAt === 'string'
      && Number.isFinite(Date.parse(expiresAt))
      && Date.parse(expiresAt) > Date.now()
      && mode.config.modules.includes(module)
  })
}
