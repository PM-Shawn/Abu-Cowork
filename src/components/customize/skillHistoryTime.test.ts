import { describe, it, expect } from 'vitest';
import { relativeTime } from './skillHistoryTime';

describe('relativeTime', () => {
  const NOW = 1_700_000_000_000;

  it('renders sub-minute diffs as "just now"', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('just now');
  });

  it('renders sub-hour diffs in minutes', () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
  });

  it('renders sub-day diffs in hours', () => {
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
  });

  it('renders diffs of a day or more in days', () => {
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2 d ago');
  });
});
