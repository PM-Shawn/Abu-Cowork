import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { markSeen, fetchUnseenAnnouncements, type AnnouncementItem } from './consoleAnnouncement'

// VITE_CONSOLE_URL is set in .env.local, so fetch will always be attempted.
// We mock it globally to control what the API returns.

const SEEN_KEY = 'abu_seen_announcements'

// ── helpers ──────────────────────────────────────────────────────────────────

function writeSeenIds(ids: number[]) {
  localStorage.setItem(SEEN_KEY, JSON.stringify(ids.map(String)))
}

function readSeenIds(): string[] {
  const raw = localStorage.getItem(SEEN_KEY)
  return raw ? (JSON.parse(raw) as string[]) : []
}

let _nextId = 1
function makeItem(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  const id = _nextId++
  return { id, slug: `slug-${id}`, type: 'general', title: `Item ${id}`, body: null, ctaUrl: null, ctaLabel: null, publishedAt: null, ...overrides }
}

// ── markSeen ─────────────────────────────────────────────────────────────────

describe('markSeen', () => {
  beforeEach(() => { localStorage.clear(); _nextId = 1 })

  it('writes id to localStorage on first call', () => {
    markSeen(1)
    expect(readSeenIds()).toContain('1')
  })

  it('accumulates multiple ids across calls', () => {
    markSeen(1)
    markSeen(2)
    const ids = readSeenIds()
    expect(ids).toContain('1')
    expect(ids).toContain('2')
  })

  it('does not duplicate an id already present', () => {
    markSeen(1)
    markSeen(1)
    expect(readSeenIds().filter((s) => s === '1').length).toBe(1)
  })

  it('caps stored list at 200 and keeps newest entries', () => {
    writeSeenIds(Array.from({ length: 200 }, (_, i) => i))
    markSeen(9999)
    const stored = readSeenIds()
    expect(stored.length).toBe(200)
    expect(stored).toContain('9999')
    expect(stored).not.toContain('0')
  })

  it('recovers from corrupt localStorage JSON without throwing', () => {
    localStorage.setItem(SEEN_KEY, 'not-valid-json')
    expect(() => markSeen(1)).not.toThrow()
    expect(readSeenIds()).toContain('1')
  })
})

// ── fetchUnseenAnnouncements ──────────────────────────────────────────────────

describe('fetchUnseenAnnouncements', () => {
  beforeEach(() => {
    localStorage.clear()
    _nextId = 1
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns all items when none are seen yet', async () => {
    const items = [makeItem(), makeItem()]
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ items }) } as Response)

    const result = await fetchUnseenAnnouncements()
    expect(result).toHaveLength(2)
  })

  it('filters out already-seen ids', async () => {
    const a = makeItem()
    const b = makeItem()
    writeSeenIds([a.id])
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ items: [a, b] }) } as Response)

    const result = await fetchUnseenAnnouncements()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(b.id)
  })

  it('returns empty array when all items are already seen', async () => {
    const a = makeItem()
    const b = makeItem()
    writeSeenIds([a.id, b.id])
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ items: [a, b] }) } as Response)

    const result = await fetchUnseenAnnouncements()
    expect(result).toEqual([])
  })

  it('returns empty array on non-ok HTTP response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response)
    const result = await fetchUnseenAnnouncements()
    expect(result).toEqual([])
  })

  it('returns empty array when fetch throws', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))
    const result = await fetchUnseenAnnouncements()
    expect(result).toEqual([])
  })

  it('handles missing items field in response gracefully', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
    const result = await fetchUnseenAnnouncements()
    expect(result).toEqual([])
  })
})
