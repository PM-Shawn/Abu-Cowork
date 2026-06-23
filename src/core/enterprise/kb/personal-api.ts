// src/core/enterprise/kb/personal-api.ts
// Client-side wrappers for /api/me/kb/* — employee self-service personal KB endpoints.
import { callEnterprise } from '@/core/enterprise/api'
import type { KbCatalogEntry } from './api'

export interface PersonalKbDoc {
  id: string
  filename: string
  mime: string
  sizeBytes: number
  status: string
  error: string | null
  createdAt: string
}

export async function listMyKbs(): Promise<KbCatalogEntry[]> {
  const r = await callEnterprise<{ items: KbCatalogEntry[] }>('/api/me/kb')
  return r.items
}

export async function createMyKb(input: { name: string; description?: string }): Promise<KbCatalogEntry> {
  const r = await callEnterprise<{ ok: true; kb: KbCatalogEntry }>('/api/me/kb', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return r.kb
}

export async function deleteMyKb(kbId: string): Promise<void> {
  await callEnterprise(`/api/me/kb/${kbId}`, { method: 'DELETE' })
}

export async function listMyKbDocs(kbId: string): Promise<PersonalKbDoc[]> {
  const r = await callEnterprise<{ items: PersonalKbDoc[] }>(`/api/me/kb/${kbId}/documents`)
  return r.items
}

export async function uploadMyKbDoc(kbId: string, file: File): Promise<PersonalKbDoc> {
  // FormData multipart — callEnterprise doesn't support FormData; use fetch directly with bearer token.
  const { useEnterpriseStore } = await import('@/stores/enterpriseStore')
  const m = useEnterpriseStore.getState().mode
  if (m.kind !== 'enterprise') throw new Error('not in enterprise mode')
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${m.binding.serverUrl.replace(/\/$/, '')}/api/me/kb/${kbId}/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${m.binding.accessToken}` },
    body: form,
  })
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return (body as { doc: PersonalKbDoc }).doc
}

export async function deleteMyKbDoc(kbId: string, docId: string): Promise<void> {
  await callEnterprise(`/api/me/kb/${kbId}/documents/${docId}`, { method: 'DELETE' })
}
