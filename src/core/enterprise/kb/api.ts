// src/core/enterprise/kb/api.ts
import { callEnterprise } from '@/core/enterprise/api'

export interface KbCatalogEntry {
  id: string; name: string; description: string | null;
  scope: string; embeddingModel: string;
}

export interface KbQueryChunk {
  id: string; documentId: string; ord: number;
  text: string; score: number; filename?: string;
}

export interface KbQueryResult {
  results: KbQueryChunk[]
  latencyMs: number
}

export async function listKbs(): Promise<KbCatalogEntry[]> {
  const r = await callEnterprise<{ items: KbCatalogEntry[] }>('/api/kb/catalog')
  return r.items
}

export async function queryKb(kbId: string, query: string, topK = 8): Promise<KbQueryResult> {
  return callEnterprise<KbQueryResult>('/api/kb/query', {
    method: 'POST',
    body: JSON.stringify({ kbId, query, topK }),
  })
}
