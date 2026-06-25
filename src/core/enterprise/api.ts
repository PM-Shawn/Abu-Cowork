// src/core/enterprise/api.ts
import { getBinding, useEnterpriseStore } from '@/stores/enterpriseStore'
import type { EnterpriseBinding } from './types'
import { refreshAccessToken } from './token-refresh'

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

/**
 * Thrown when the session is unrecoverable — the refresh token is missing,
 * expired, or the server rejected it.  Callers should clear local credentials
 * and redirect the user to re-login.
 */
export class EnterpriseSessionExpiredError extends Error {
  constructor(cause?: unknown) {
    super('Enterprise session expired — please re-login')
    this.name = 'EnterpriseSessionExpiredError'
    if (cause instanceof Error) this.cause = cause
  }
}

// ─── Single-flight refresh ────────────────────────────────────────────────────
//
// At most one in-flight refresh call exists at a time.  Concurrent callers that
// trigger (or arrive during) a refresh all await the SAME promise, so the server
// only receives one rotation request.  The promise is cleared (set to null) once
// it settles, regardless of outcome.
let inflightRefresh: Promise<EnterpriseBinding> | null = null

/**
 * Internal: call the refresh endpoint, persist the new token pair, and return
 * the updated binding.  Must only be called when `b.refreshToken` is defined.
 */
async function doRefresh(b: EnterpriseBinding): Promise<EnterpriseBinding> {
  const result = await refreshAccessToken(b.serverUrl, b.refreshToken!)
  const updated: EnterpriseBinding = {
    ...b,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    accessExpiresAt: result.accessExpiresAt,
  }
  // Persist to disk and update in-memory store.
  await useEnterpriseStore.getState().bind(updated)
  return updated
}

/**
 * Ensures at most one refresh is in-flight at a time (single-flight pattern).
 * Returns the updated `EnterpriseBinding` with fresh tokens.
 * Throws if the refresh fails (caller converts to `EnterpriseSessionExpiredError`).
 */
function triggerRefresh(b: EnterpriseBinding): Promise<EnterpriseBinding> {
  if (!inflightRefresh) {
    inflightRefresh = doRefresh(b).finally(() => {
      inflightRefresh = null
    })
  }
  return inflightRefresh
}

/** How many seconds before expiry to proactively refresh (60 s buffer). */
const PROACTIVE_REFRESH_BUFFER_MS = 60_000

/**
 * Exposed for testing only — resets the module-level single-flight lock.
 * @internal
 */
export function _resetInflightForTesting(): void {
  inflightRefresh = null
}

// ─── callEnterprise ───────────────────────────────────────────────────────────

export async function callEnterprise<T = unknown>(
  path: string,
  init?: RequestInit & { serverUrl?: string }
): Promise<T> {
  let b = getBinding()
  const base = init?.serverUrl ?? b?.serverUrl
  if (!base) throw new Error('not bound to an enterprise')

  // Proactive refresh: if the access token is about to expire AND we have a
  // refresh token, renew before even making the request.
  if (
    b?.refreshToken &&
    b.accessExpiresAt &&
    Date.now() + PROACTIVE_REFRESH_BUFFER_MS >= new Date(b.accessExpiresAt).getTime()
  ) {
    try {
      b = await triggerRefresh(b)
    } catch (err) {
      throw new EnterpriseSessionExpiredError(err)
    }
  }

  const { serverUrl: _unused, ...fetchInit } = init ?? {}

  const buildHeaders = (binding: EnterpriseBinding | null): Record<string, string> => ({
    'content-type': 'application/json',
    ...(fetchInit.headers as Record<string, string> ?? {}),
    ...(binding?.accessToken ? { authorization: `Bearer ${binding.accessToken}` } : {}),
  })

  const endpoint = `${base.replace(/\/$/, '')}${path}`
  const res = await fetch(endpoint, { ...fetchInit, headers: buildHeaders(b) })
  const body = await res.json().catch(() => ({}))

  // Reactive refresh: server returned 401 and we have a refresh token.
  // Try to refresh once, then retry the original request.
  if (res.status === 401 && b?.refreshToken) {
    try {
      b = await triggerRefresh(b)
    } catch (err) {
      throw new EnterpriseSessionExpiredError(err)
    }
    const retryRes = await fetch(endpoint, { ...fetchInit, headers: buildHeaders(b) })
    const retryBody = await retryRes.json().catch(() => ({}))
    if (!retryRes.ok) throw new EnterpriseApiError(retryRes.status, retryBody)
    return retryBody as T
  }

  if (!res.ok) throw new EnterpriseApiError(res.status, body)
  return body as T
}
