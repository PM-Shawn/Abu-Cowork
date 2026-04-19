/**
 * 2h sliding-window dedup cache for Notice Bus.
 *
 * Producers pass a `dedupKey` — a semantic fingerprint defined per
 * event type (see PRD-01 dedupKey rules table). If the same key is
 * published again within DEDUP_WINDOW_MS, the second call is considered
 * a duplicate and `bus.publish` returns null.
 *
 * In-memory only. Process restart resets the cache; this is acceptable
 * because the 2h window is short and the guarantee we want is
 * "don't spam the user with the same event inside one session", not
 * "no duplicates ever".
 */

// ── Constants ───────────────────────────────────────────────────────────

export const DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;

// ── State ───────────────────────────────────────────────────────────────

interface DedupEntry {
  id: string;
  expiresAt: number;
}

const cache = new Map<string, DedupEntry>();

// ── API ─────────────────────────────────────────────────────────────────

/**
 * If `dedupKey` was recorded within the window, return the prior notice
 * id. Else return null. Expired entries are cleaned up lazily on check.
 */
export function checkDedup(
  dedupKey: string,
  now: number = Date.now(),
): string | null {
  const entry = cache.get(dedupKey);
  if (!entry) return null;
  if (entry.expiresAt > now) return entry.id;
  cache.delete(dedupKey);
  return null;
}

/** Record a `dedupKey → noticeId` association valid for DEDUP_WINDOW_MS. */
export function recordDedup(
  dedupKey: string,
  noticeId: string,
  now: number = Date.now(),
): void {
  cache.set(dedupKey, {
    id: noticeId,
    expiresAt: now + DEDUP_WINDOW_MS,
  });
}

// ── Test utilities ──────────────────────────────────────────────────────

export function clearDedupCacheForTest(): void {
  cache.clear();
}

export function dedupCacheSizeForTest(): number {
  return cache.size;
}
