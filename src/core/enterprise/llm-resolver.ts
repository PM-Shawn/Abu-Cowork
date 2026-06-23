// src/core/enterprise/llm-resolver.ts
import { useEnterpriseStore } from '@/stores/enterpriseStore'

export interface ResolvedEnterpriseLlm {
  baseUrl: string
  apiKey: string
}

/**
 * Returns enterprise LLM context if usable; null otherwise.
 *
 * Returns null when:
 * - mode is 'personal' (no enterprise binding)
 * - mode is 'offline' (gateway unreachable — do NOT fall back to personal key)
 * - binding has no llmEndpoint / llmVirtualKey (legacy bind before 2.C)
 */
export function resolveEnterpriseLlm(): ResolvedEnterpriseLlm | null {
  const m = useEnterpriseStore.getState().mode
  if (m.kind !== 'enterprise') return null  // 'personal' and 'offline' both return null
  const b = m.binding
  if (!b.llmEndpoint || !b.llmVirtualKey) return null
  return { baseUrl: b.llmEndpoint, apiKey: b.llmVirtualKey }
}

/**
 * Whether the client MUST use the enterprise LLM gateway.
 * Returns true for both 'enterprise' and 'offline' modes —
 * offline means the gateway is unreachable, which throws an error
 * rather than silently falling back to a personal API key.
 */
export function isEnterpriseLlmEnforced(): boolean {
  const m = useEnterpriseStore.getState().mode
  return m.kind !== 'personal'
}

/** Returns true if enforced AND a resolved context is available. */
export function canCallEnterpriseLlm(): boolean {
  return isEnterpriseLlmEnforced() && resolveEnterpriseLlm() !== null
}
