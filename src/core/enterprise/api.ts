// src/core/enterprise/api.ts
import { getBinding } from '@/stores/enterpriseStore'

export class EnterpriseApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'EnterpriseApiError'
    this.status = status
    this.body = body
  }
}

export async function callEnterprise<T = unknown>(
  path: string,
  init?: RequestInit & { serverUrl?: string }
): Promise<T> {
  const b = getBinding()
  const base = init?.serverUrl ?? b?.serverUrl
  if (!base) throw new Error('not bound to an enterprise')
  const { serverUrl: _unused, ...fetchInit } = init ?? {}
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(fetchInit.headers as Record<string, string> ?? {}),
  }
  if (b?.accessToken) headers['authorization'] = `Bearer ${b.accessToken}`
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, { ...fetchInit, headers })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new EnterpriseApiError(res.status, body)
  return body as T
}
