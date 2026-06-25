// src/core/enterprise/useEnterpriseModels.ts
import { useEffect, useState } from 'react'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { resolveEnterpriseLlm } from './llm-resolver'

/**
 * Fetches the available model list from the enterprise LiteLLM gateway.
 * Returns null when not in enterprise mode or gateway has no virtual key.
 * Returns [] if the fetch fails (gateway down).
 */
export function useEnterpriseModels(): string[] | null {
  const mode = useEnterpriseStore(s => s.mode)
  const llmEndpoint = mode.kind === 'enterprise' ? mode.binding.llmEndpoint : null
  const [models, setModels] = useState<string[] | null>(null)

  useEffect(() => {
    if (mode.kind !== 'enterprise') {
      setModels(null)
      return
    }
    const r = resolveEnterpriseLlm()
    if (!r) {
      setModels(null)
      return
    }
    let cancelled = false
    fetch(`${r.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${r.apiKey}` },
    })
      .then(res => res.ok ? res.json() : { data: [] })
      .then((j: { data?: Array<{ id: string }> }) => {
        if (!cancelled) setModels(j.data?.map(m => m.id) ?? [])
      })
      .catch(() => {
        if (!cancelled) setModels([])
      })
    return () => { cancelled = true }
  }, [mode.kind, llmEndpoint])

  return models
}
