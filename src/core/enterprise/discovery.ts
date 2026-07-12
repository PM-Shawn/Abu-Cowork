// src/core/enterprise/discovery.ts
// Server URL discovery: deep-link parsing + existing binding fallback.
import { loadBinding } from './boot'

export interface EnrollDeepLink {
  serverUrl: string
  enrollmentToken?: string
}

/**
 * Parse an abu://enroll deep link URL.
 * Returns null if the URL is invalid (wrong scheme, missing server param, etc.)
 */
export function parseEnrollDeepLink(url: string): EnrollDeepLink | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'abu:') return null
    if (parsed.hostname !== 'enroll') return null
    const server = parsed.searchParams.get('server')
    if (!server) return null
    const token = parsed.searchParams.get('token')
    const result: EnrollDeepLink = { serverUrl: server }
    if (token) result.enrollmentToken = token
    return result
  } catch {
    return null
  }
}

/**
 * Resolve the server URL for enterprise mode.
 * Priority:
 *   1. Deep link injection point (V2 / future: @tauri-apps/plugin-deep-link not yet installed)
 *      Pass `opts.deepLinkUrl` to inject a deep link URL. If present and parseable, use it.
 *   2. Existing binding (loadBinding from boot.ts) — if binding exists, return its serverUrl.
 *   3. Manual entry — return null (caller/UI handles prompting user to enter serverUrl).
 *
 * NOTE: Deep link plugin integration (@tauri-apps/plugin-deep-link) is left for V2.
 * The `opts.deepLinkUrl` injection point is the interface for that future integration.
 */
export async function resolveServerUrl(opts?: {
  deepLinkUrl?: string
}): Promise<{ serverUrl: string; enrollmentToken?: string } | null> {
  try {
    if (opts?.deepLinkUrl) {
      const parsed = parseEnrollDeepLink(opts.deepLinkUrl)
      if (parsed) return parsed
    }
    const binding = await loadBinding()
    if (binding) return { serverUrl: binding.serverUrl }
    return null
  } catch {
    return null
  }
}
