/**
 * Memory age helpers — recency signal that replaces accessCount.
 *
 * Aligned with Claude Code's memoryAge.ts but tuned for desktop/office users:
 * Abu users' memories (preferences, project facts) age slower than CC's
 * code-related memories, so the staleness threshold is 60 days here vs CC's 1 day.
 */

const DAY_MS = 86_400_000;
const STALE_DAYS = 60;

/**
 * Days elapsed since `updated`. Floor-rounded — 0 for today, 1 for
 * yesterday. Negative inputs (future timestamp, clock skew) clamp to 0.
 */
export function memoryAgeDays(updatedMs: number): number {
  return Math.max(0, Math.floor((Date.now() - updatedMs) / DAY_MS));
}

/**
 * Human-readable age string in Chinese. Models reason poorly about raw
 * ISO timestamps — "60 天前" triggers staleness reasoning more reliably.
 */
export function memoryAge(updatedMs: number): string {
  const d = memoryAgeDays(updatedMs);
  if (d === 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  const months = Math.floor(d / 30);
  if (months < 12) return `${months} 个月前`;
  const years = Math.floor(d / 365);
  return `${years} 年前`;
}

/**
 * Whether a memory should be flagged as stale (>60 days untouched).
 */
export function isStale(updatedMs: number): boolean {
  return memoryAgeDays(updatedMs) > STALE_DAYS;
}

/**
 * Plain staleness caveat for memories >60 days old. Returns '' for fresh
 * memories — warning there is just noise.
 *
 * Caller wraps in <system-reminder> if needed; this returns the raw text
 * so it can also embed in <memory> blocks for Phase 2 injection.
 */
export function memoryFreshnessText(updatedMs: number): string {
  if (!isStale(updatedMs)) return '';
  const d = memoryAgeDays(updatedMs);
  return (
    `这条记忆已 ${d} 天未更新，可能已过时。` +
    `如果涉及对当前现状的判断（如用户角色、项目状态），请向用户确认；` +
    `引用前请验证仍然适用。`
  );
}
