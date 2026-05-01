import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { memoryAgeDays, memoryAge, isStale, memoryFreshnessText } from './age';

const DAY = 86_400_000;
const NOW = 1_750_000_000_000; // arbitrary fixed point

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('memoryAgeDays', () => {
  it('returns 0 for today', () => {
    expect(memoryAgeDays(NOW)).toBe(0);
    expect(memoryAgeDays(NOW - 1000)).toBe(0);
  });

  it('returns 1 for yesterday', () => {
    expect(memoryAgeDays(NOW - DAY)).toBe(1);
  });

  it('returns 30 for 30 days ago', () => {
    expect(memoryAgeDays(NOW - 30 * DAY)).toBe(30);
  });

  it('clamps future timestamps to 0', () => {
    expect(memoryAgeDays(NOW + DAY)).toBe(0);
  });
});

describe('memoryAge', () => {
  it('formats days correctly', () => {
    expect(memoryAge(NOW)).toBe('今天');
    expect(memoryAge(NOW - DAY)).toBe('昨天');
    expect(memoryAge(NOW - 5 * DAY)).toBe('5 天前');
    expect(memoryAge(NOW - 29 * DAY)).toBe('29 天前');
  });

  it('formats months for 30+ days', () => {
    expect(memoryAge(NOW - 30 * DAY)).toBe('1 个月前');
    expect(memoryAge(NOW - 90 * DAY)).toBe('3 个月前');
  });

  it('formats years for 365+ days', () => {
    expect(memoryAge(NOW - 365 * DAY)).toBe('1 年前');
    expect(memoryAge(NOW - 730 * DAY)).toBe('2 年前');
  });
});

describe('isStale', () => {
  it('is false for fresh memories', () => {
    expect(isStale(NOW)).toBe(false);
    expect(isStale(NOW - 30 * DAY)).toBe(false);
    expect(isStale(NOW - 60 * DAY)).toBe(false);
  });

  it('is true beyond 60 days', () => {
    expect(isStale(NOW - 61 * DAY)).toBe(true);
    expect(isStale(NOW - 365 * DAY)).toBe(true);
  });
});

describe('memoryFreshnessText', () => {
  it('returns empty string for fresh memories', () => {
    expect(memoryFreshnessText(NOW)).toBe('');
    expect(memoryFreshnessText(NOW - 30 * DAY)).toBe('');
  });

  it('returns warning text for stale memories', () => {
    const text = memoryFreshnessText(NOW - 70 * DAY);
    expect(text).toContain('70 天未更新');
    expect(text).toContain('请向用户确认');
  });
});
