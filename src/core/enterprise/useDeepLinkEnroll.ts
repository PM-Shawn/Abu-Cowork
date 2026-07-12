// src/core/enterprise/useDeepLinkEnroll.ts
// React hook: listens for abu://enroll deep links and exposes a pending enroll
// state that the host (App.tsx) can use to drive the BindToEnterpriseFlow UI.
//
// Two sources are checked:
//   1. getCurrent() — URL that launched the app cold (macOS / Windows).
//   2. onOpenUrl()  — URL that arrived while the app was already running (macOS).
//
// The hook is safe to call in non-Tauri (browser) builds: both plugin calls will
// reject, we catch those errors silently, and no state is set.
import { useEffect, useState } from 'react'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { parseEnrollDeepLink } from '@/core/enterprise/discovery'

export interface PendingEnroll {
  serverUrl: string
  enrollmentToken?: string
}

/**
 * Returns the pending deep-link enroll data (if any) and a dismiss callback.
 * Idempotent: mounting multiple times is safe because the hook cleans up its
 * listener on unmount and setCurrent sets the same value.
 */
export function useDeepLinkEnroll(): {
  pendingEnroll: PendingEnroll | null
  dismissEnroll: () => void
} {
  const [pendingEnroll, setPendingEnroll] = useState<PendingEnroll | null>(null)

  useEffect(() => {
    let cancelled = false

    function applyUrl(url: string): void {
      const parsed = parseEnrollDeepLink(url)
      if (parsed && !cancelled) {
        setPendingEnroll(parsed)
      }
    }

    // Check for a URL that cold-launched the app (available immediately on startup).
    getCurrent()
      .then(urls => {
        if (cancelled || !urls) return
        for (const url of urls) {
          applyUrl(url)
        }
      })
      .catch(err => {
        console.warn('[deepLink] getCurrent error:', err)
      })

    // Subscribe to URLs that arrive while the app is already running.
    let unlisten: (() => void) | undefined
    onOpenUrl(urls => {
      for (const url of urls) {
        applyUrl(url)
      }
    })
      .then(fn => {
        if (cancelled) {
          fn() // already unmounted — immediately remove the listener
          return
        }
        unlisten = fn
      })
      .catch(err => {
        console.warn('[deepLink] onOpenUrl error:', err)
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return {
    pendingEnroll,
    dismissEnroll: () => setPendingEnroll(null),
  }
}
