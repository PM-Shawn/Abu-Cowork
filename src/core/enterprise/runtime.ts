import { startHeartbeat } from './heartbeat'

let activation: Promise<void> | null = null

/**
 * Start the enterprise protocol loop and the build-specific business modules.
 * Safe to call both when restoring a persisted binding and immediately after
 * a first-time bind in the same renderer session.
 */
export function activateEnterpriseRuntime(): Promise<void> {
  if (activation) return activation
  activation = (async () => {
    startHeartbeat()
    const { initEnterpriseModules } = await import('@enterprise-modules')
    await initEnterpriseModules()
  })().catch((error: unknown) => {
    activation = null
    throw error
  })
  return activation
}
