import { format as i18nFormat, getI18n } from '@/i18n';

const MS_MIN = 60_000;
const MS_HOUR = MS_MIN * 60;
const MS_DAY = MS_HOUR * 24;

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isSameLocalDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function timeOnly(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function dateOnly(ts: number, withYear: boolean): string {
  const d = new Date(ts);
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return withYear ? `${d.getFullYear()}-${m}-${day}` : `${m}-${day}`;
}

/**
 * Smart timestamp for the per-message hover layer.
 * - Within 1 min  → "刚刚 / Just now"
 * - Within 1 hour → "N 分钟前 / N min ago"
 * - Same day      → "HH:MM"
 * - Yesterday     → "昨天 HH:MM"
 * - Same year     → "MM-DD HH:MM"
 * - Otherwise     → "YYYY-MM-DD HH:MM"
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const t = getI18n();
  const diff = now - ts;

  if (diff < MS_MIN) return t.chat.timeJustNow;
  if (diff < MS_HOUR) {
    const mins = Math.floor(diff / MS_MIN);
    return i18nFormat(t.chat.timeMinutesAgo, { n: mins });
  }

  if (isSameLocalDay(ts, now)) return timeOnly(ts);

  const dayDiff = Math.floor(
    (startOfLocalDay(now) - startOfLocalDay(ts)) / MS_DAY
  );
  if (dayDiff === 1) return `${t.chat.dayYesterday} ${timeOnly(ts)}`;

  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return `${dateOnly(ts, !sameYear)} ${timeOnly(ts)}`;
}

