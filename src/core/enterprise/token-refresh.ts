// src/core/enterprise/token-refresh.ts
// Calls POST /api/client/v1/auth/refresh and returns a new token pair.
// This module is intentionally side-effect-free: it only performs the HTTP call
// and does NOT update any store/FS.  The caller (api.ts) is responsible for
// persisting the result.

export interface RefreshResult {
  /** New short-lived JWT access token */
  accessToken: string
  /** New opaque refresh token (old one is now revoked) */
  refreshToken: string
  /** ISO 8601 timestamp at which the new access token expires */
  accessExpiresAt: string
}

/** Thrown when the /auth/refresh HTTP call returns a non-2xx response. */
export class TokenRefreshError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`Token refresh failed: HTTP ${status}`)
    this.name = 'TokenRefreshError'
    this.status = status
    this.body = body
  }
}

/**
 * Exchange an existing refresh token for a new access+refresh token pair.
 *
 * Calls `POST {serverUrl}/api/client/v1/auth/refresh`.
 * Throws {@link TokenRefreshError} on any non-2xx HTTP response (including
 * `token_reuse_detected`, `expired_token`, `unauthenticated`, etc.).
 *
 * @param serverUrl    Base server URL (trailing slash is stripped).
 * @param refreshToken The current opaque refresh token.
 */
export async function refreshAccessToken(
  serverUrl: string,
  refreshToken: string,
): Promise<RefreshResult> {
  const url = `${serverUrl.replace(/\/$/, '')}/api/client/v1/auth/refresh`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new TokenRefreshError(res.status, body)
  }
  const data = body as { access_token: string; expires_in: number; refresh_token: string }
  // Compute expiry from the server-reported `expires_in` offset.
  const accessExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt,
  }
}
