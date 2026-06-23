// src/core/enterprise/mounts.ts
// EXTENSION POINTS — semi-public API. Breaking changes require deprecation cycle.
// V1 implementations are empty containers + default UI; V1.5 introduces plugins
// that can override default implementations via registerEnterpriseMount().

import type { ComponentType, ReactNode } from 'react'
import type { EnterpriseBinding, EnterpriseConfigSnapshot } from './types'

/** Generic slot — renders nothing when no implementation registered. */
export interface SlotProps {
  binding: EnterpriseBinding
  config: EnterpriseConfigSnapshot | null
}

/** Tab in a tabbed view (used for Skill / MCP browser enterprise tabs). */
export interface TabSlotProps extends SlotProps {
  onSelectSkill?: (id: string) => void
  onSelectMcp?: (id: string) => void
}

/** Brand renderer — shown wherever the host brand appears. */
export interface BrandSlotProps {
  binding: EnterpriseBinding | null
  config: EnterpriseConfigSnapshot | null
  size?: 'sm' | 'md' | 'lg'
}

/** Advisor — pure render with no side effects (recommendations only in V1). */
export interface PolicyAdvisorProps {
  binding: EnterpriseBinding
  config: EnterpriseConfigSnapshot | null
  context: 'soul' | 'permissions' | 'global'
}

/** /me transparency page. */
export interface MeTransparencyProps extends SlotProps {}

// ===== V1.5+ extension slots (declared early so future plugins can target a stable shape) =====

export interface KbModuleProps extends SlotProps {
  scope: 'personal' | 'team' | 'org'
}
export interface PolicyEnforcerProps extends SlotProps {
  resource: 'tool' | 'skill' | 'mcp'
  action: string
}
export interface AgentMarketProps extends SlotProps {}
export interface ImConnectorProps extends SlotProps {}
export interface CrossUserTaskProps extends SlotProps {}

// ===== Registry =====

export interface EnterpriseMounts {
  brandSlot: ComponentType<BrandSlotProps>
  skillTab: ComponentType<TabSlotProps>
  mcpTab: ComponentType<TabSlotProps>
  meTransparencyPage: ComponentType<MeTransparencyProps>
  policyAdvisor: ComponentType<PolicyAdvisorProps>

  // optional — undefined unless V1.5+ plugin overrides
  kbModule?: ComponentType<KbModuleProps>
  policyEnforcer?: ComponentType<PolicyEnforcerProps>
  agentMarket?: ComponentType<AgentMarketProps>
  imConnector?: ComponentType<ImConnectorProps>
  crossUserTasks?: ComponentType<CrossUserTaskProps>
}

/** No-op default that renders null. Used as fallback when a slot is unset. */
function NullComponent(): ReactNode { return null }

const _registry: EnterpriseMounts = {
  brandSlot: NullComponent as unknown as ComponentType<BrandSlotProps>,
  skillTab: NullComponent as unknown as ComponentType<TabSlotProps>,
  mcpTab: NullComponent as unknown as ComponentType<TabSlotProps>,
  meTransparencyPage: NullComponent as unknown as ComponentType<MeTransparencyProps>,
  policyAdvisor: NullComponent as unknown as ComponentType<PolicyAdvisorProps>,
}

export function registerEnterpriseMount<K extends keyof EnterpriseMounts>(key: K, impl: EnterpriseMounts[K]): void {
  (_registry as unknown as Record<string, unknown>)[key] = impl
}

export function getEnterpriseMount<K extends keyof EnterpriseMounts>(key: K): EnterpriseMounts[K] {
  return _registry[key]
}

export function getAllMounts(): Readonly<EnterpriseMounts> { return _registry }

/** Convenience: render a component by mount key with props. */
export function MountPoint<K extends keyof EnterpriseMounts>({ slot, ...props }: { slot: K } & Record<string, unknown>): ReactNode {
  const Impl = getEnterpriseMount(slot) as ComponentType<Record<string, unknown>> | undefined
  return Impl ? <Impl {...props} /> : null
}
