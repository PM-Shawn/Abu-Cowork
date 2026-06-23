// src/core/enterprise/policy/enforcer.ts
// Side-effect import: registers policyEnforcer in the enterprise mounts registry.
// Also exports getCurrentPolicy() — the single read-point for the active policy snapshot.
import type { ComponentType } from 'react'
import type { PolicyEnforcerProps } from '@/core/enterprise/mounts'
import { registerEnterpriseMount } from '@/core/enterprise/mounts'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import type { EffectivePolicy } from './types'

/**
 * Get the current effective policy from the heartbeat config snapshot.
 * Returns null when not in enterprise mode or when the server hasn't returned
 * a policy yet (e.g. first heartbeat pending).
 *
 * Usage: `getCurrentPolicy()` from tool dispatcher / skill installer hooks.
 */
export function getCurrentPolicy(): EffectivePolicy | null {
  const mode = useEnterpriseStore.getState().mode
  let config: Record<string, unknown> | null = null
  if (mode.kind === 'enterprise') {
    config = mode.config as unknown as Record<string, unknown> | null
  } else if (mode.kind === 'offline') {
    config = mode.lastConfig as unknown as Record<string, unknown> | null
  }
  if (!config) return null
  return (config as Record<string, unknown>).policies as EffectivePolicy ?? null
}

/**
 * PolicyEnforcer is a purely-declarative mount point component.
 * Actual enforcement is done imperatively in the tool dispatcher and skill installer.
 * This component renders nothing — the mount registration is the side-effect.
 */
function PolicyEnforcer(_props: PolicyEnforcerProps): null {
  return null
}

registerEnterpriseMount('policyEnforcer', PolicyEnforcer as ComponentType<PolicyEnforcerProps>)

export default PolicyEnforcer
