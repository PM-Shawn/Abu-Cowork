// src/core/enterprise/auth.ts
import { openUrl } from '@tauri-apps/plugin-opener'
import { getOrCreateClientId } from './client-id'

interface InitResp {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

interface PollResp {
  access_token: string
  token_type: string
  expires_in: number
  scopes: string[]
  llm_virtual_key?: string | null
  llm_endpoint?: string | null
  /** Opaque refresh token returned by bind/poll (server O4+). */
  refresh_token?: string | null
  /** ISO 8601 idle-expiry of the refresh token. */
  refresh_idle_expires_at?: string | null
  /** Token family identifier for rotation tracking. */
  family_id?: string | null
}

export interface BindResult {
  serverUrl: string
  accessToken: string
  /** ISO 8601 expiry of the access token (computed from expires_in). */
  accessExpiresAt?: string
  /** Opaque refresh token; present when server returns one. */
  refreshToken?: string
  scopes: string[]
  llmEndpoint: string | null
  llmVirtualKey: string | null
}

export async function startBind(
  serverUrl: string,
  clientLabel?: string
): Promise<{ initResp: InitResp; abort: () => void; result: Promise<BindResult> }> {
  const clientId = await getOrCreateClientId()
  const base = serverUrl.replace(/\/$/, '')
  const initRes = await fetch(`${base}/api/client/bind/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, clientLabel }),
  })
  if (!initRes.ok) throw new Error(`bind init failed: HTTP ${initRes.status}`)
  const initResp = (await initRes.json()) as InitResp

  let aborted = false
  const result = (async (): Promise<BindResult> => {
    // open browser at completion URL with user_code prefilled
    await openUrl(initResp.verification_uri_complete)

    const deadline = Date.now() + initResp.expires_in * 1000
    let interval = initResp.interval * 1000
    while (Date.now() < deadline) {
      if (aborted) throw new Error('bind aborted')
      await new Promise<void>(r => setTimeout(r, interval))
      const pollRes = await fetch(`${base}/api/client/bind/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: initResp.device_code }),
      })
      if (pollRes.status === 200) {
        const r = (await pollRes.json()) as PollResp
        return {
          serverUrl: base,
          accessToken: r.access_token,
          accessExpiresAt: r.expires_in > 0
            ? new Date(Date.now() + r.expires_in * 1000).toISOString()
            : undefined,
          refreshToken: r.refresh_token ?? undefined,
          scopes: r.scopes,
          llmEndpoint: r.llm_endpoint ?? null,
          llmVirtualKey: r.llm_virtual_key ?? null,
        }
      }
      if (pollRes.status === 429) { interval += 1000; continue }  // slow_down
      if (pollRes.status === 425) continue                          // authorization_pending
      if (pollRes.status === 410) throw new Error('device code expired')
      throw new Error(`bind poll failed: HTTP ${pollRes.status}`)
    }
    throw new Error('bind timed out')
  })()

  return { initResp, abort: () => { aborted = true }, result }
}
