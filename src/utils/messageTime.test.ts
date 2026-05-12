import { describe, it, expect, beforeAll } from 'vitest';
import { formatRelativeTime, isSameLocalDay } from './messageTime';
import { setLanguage } from '@/i18n';

// Tests below assert Chinese labels — pin the locale so they don't break when
// the test runtime defaults differ from `zh-CN`.
beforeAll(() => {
  setLanguage('zh-CN');
});

// Fixed reference: 2026-04-30 10:00:00 local time. Tests treat this as `now`.
const REF = new Date(2026, 3, 30, 10, 0, 0).getTime();

const minutes = (n: number) => n * 60_000;

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

