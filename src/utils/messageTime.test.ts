import { describe, it, expect, beforeAll } from 'vitest';
import { formatRelativeTime, formatDayLabel, isSameLocalDay } from './messageTime';
import { setLanguage } from '@/i18n';

// Tests below assert Chinese labels — pin the locale so they don't break when
// the test runtime defaults differ from `zh-CN`.
beforeAll(() => {
  setLanguage('zh-CN');
});

// Fixed reference: 2026-04-30 10:00:00 local time. Tests treat this as `now`.
const REF = new Date(2026, 3, 30, 10, 0, 0).getTime();

const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 60 * 60_000;
const days = (n: number) => n * 24 * 60 * 60_000;

describe('isSameLocalDay', () => {
  it('returns true for two timestamps on the same calendar day', () => {
    const a = new Date(2026, 3, 30, 0, 0, 1).getTime();
    const b = new Date(2026, 3, 30, 23, 59, 59).getTime();
    expect(isSameLocalDay(a, b)).toBe(true);
  });

  it('returns false across midnight', () => {
    const a = new Date(2026, 3, 30, 23, 59, 59).getTime();
    const b = new Date(2026, 4, 1, 0, 0, 1).getTime();
    expect(isSameLocalDay(a, b)).toBe(false);
  });
});

describe('formatRelativeTime', () => {
  it('"just now" within the first minute', () => {
    expect(formatRelativeTime(REF - 30_000, REF)).toBe('刚刚');
  });

  it('"N minutes ago" within the hour', () => {
    expect(formatRelativeTime(REF - minutes(15), REF)).toContain('15');
  });

  it('same-day timestamp falls back to HH:MM', () => {
    const earlier = new Date(2026, 3, 30, 7, 5).getTime();
    expect(formatRelativeTime(earlier, REF)).toBe('07:05');
  });

  it('yesterday is labeled with the friendly word', () => {
    const yesterday = new Date(2026, 3, 29, 14, 32).getTime();
    expect(formatRelativeTime(yesterday, REF)).toContain('昨天');
    expect(formatRelativeTime(yesterday, REF)).toContain('14:32');
  });

  it('older same-year shows MM-DD HH:MM', () => {
    const earlier = new Date(2026, 0, 5, 9, 15).getTime();
    expect(formatRelativeTime(earlier, REF)).toBe('01-05 09:15');
  });

  it('different year shows full YYYY-MM-DD HH:MM', () => {
    const earlier = new Date(2025, 11, 31, 9, 15).getTime();
    expect(formatRelativeTime(earlier, REF)).toBe('2025-12-31 09:15');
  });
});

describe('formatDayLabel', () => {
  it('today / yesterday / day-before-yesterday', () => {
    expect(formatDayLabel(REF, REF)).toBe('今天');
    expect(formatDayLabel(REF - days(1), REF)).toBe('昨天');
    expect(formatDayLabel(REF - days(2), REF)).toBe('前天');
  });

  it('older same-year date renders as MM-DD', () => {
    const old = new Date(2026, 0, 5, 12).getTime();
    expect(formatDayLabel(old, REF)).toBe('01-05');
  });

  it('cross-year date renders as YYYY-MM-DD', () => {
    const old = new Date(2024, 11, 31, 12).getTime();
    expect(formatDayLabel(old, REF)).toBe('2024-12-31');
  });

  // Regression: when REF time-of-day is later than the message's,
  // a naive (now - ts) / MS_DAY would be 0 (less than 24h elapsed),
  // but the message is still on the previous calendar day. The
  // implementation uses startOfLocalDay-based diff, so this should
  // be labeled "yesterday".
  it('treats <24h-old-but-different-calendar-day as yesterday', () => {
    // REF = 2026-04-30 10:00. Message at 2026-04-29 23:30 → 10.5h ago,
    // but on a different local day.
    const yesterdayLate = new Date(2026, 3, 29, 23, 30).getTime();
    expect(formatDayLabel(yesterdayLate, REF)).toBe('昨天');
  });

  it('hours offset within the same day stays "today"', () => {
    expect(formatDayLabel(REF - hours(3), REF)).toBe('今天');
  });
});
