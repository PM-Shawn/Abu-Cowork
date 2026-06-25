import { APP_VERSION } from './version'
import { getTelemetryTarget } from './consoleTelemetryTarget'

const SEEN_KEY = 'abu_seen_announcements'

export interface AnnouncementItem {
  id: number
  slug: string
  type: 'version_update' | 'feature' | 'breaking' | 'general'
  title: string
  body: string | null
  ctaUrl: string | null
  ctaLabel: string | null
  publishedAt: string | null
}

function getSeenIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const arr = raw ? (JSON.parse(raw) as string[]) : []
    return new Set(arr)
  } catch {
    return new Set()
  }
}

export function markSeen(id: number): void {
  try {
    const seen = getSeenIds()
    seen.add(String(id))
    // Keep at most 200 entries to avoid localStorage bloat
    const arr = [...seen].slice(-200)
    localStorage.setItem(SEEN_KEY, JSON.stringify(arr))
  } catch {
    // ignore
  }
}

// Returns unseen announcements. Caller decides how to display them.
export async function fetchUnseenAnnouncements(): Promise<AnnouncementItem[]> {
  const { baseUrl, enabled } = getTelemetryTarget()
  if (!enabled) return []

  try {
    // AbortSignal.timeout() requires Safari 16.4+; use AbortController for broader macOS 12 compat
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    let res: Response
    try {
      res = await fetch(`${baseUrl}/api/announcements?version=${APP_VERSION}`, {
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) return []
    const data = await res.json() as { items: AnnouncementItem[] }
    const seen = getSeenIds()
    return (data.items ?? []).filter((item) => !seen.has(String(item.id)))
  } catch {
    return []
  }
}
