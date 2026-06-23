// src/core/enterprise/llm-resolver.ts
import { useEnterpriseStore } from '@/stores/enterpriseStore'

export interface ResolvedEnterpriseLlm {
  baseUrl: string
  apiKey: string
}

/**
 * Thrown when the client is in enterprise mode but the LLM gateway is
 * unreachable or has no virtual key configured.
 * Per spec 11.e: LLM calls MUST NOT fall back to a personal API key —
 * budget bypass prevention is more important than availability.
 */
export class EnterpriseLlmUnavailableError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'EnterpriseLlmUnavailableError'
  }
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

/**
 * Resolves apiKey + baseUrl for a LLM call.
 * - Enterprise mode with valid gateway → returns gateway creds (openai-compatible)
 * - Enterprise mode without gateway → throws EnterpriseLlmUnavailableError
 * - Personal mode → returns personalApiKey + personalBaseUrl unchanged
 *
 * Usage: call once before building chatOptions; spread result into chatOptions.
 */
export function resolveEffectiveLlmCreds(
  personalApiKey: string,
  personalBaseUrl: string | undefined,
): { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean } {
  const enterprise = resolveEnterpriseLlm()
  if (enterprise) {
    return { apiKey: enterprise.apiKey, baseUrl: enterprise.baseUrl, forceOpenAiCompatible: true }
  }
  if (isEnterpriseLlmEnforced()) {
    throw new EnterpriseLlmUnavailableError(
      '企业 AI 网关不可达，无法执行 LLM 调用。请检查网络连接，或联系管理员。'
    )
  }
  return { apiKey: personalApiKey, baseUrl: personalBaseUrl, forceOpenAiCompatible: false }
}
