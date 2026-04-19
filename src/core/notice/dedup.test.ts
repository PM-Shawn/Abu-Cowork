import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkDedup,
  recordDedup,
  clearDedupCacheForTest,
  dedupCacheSizeForTest,
  DEDUP_WINDOW_MS,
} from './dedup';

describe('notice dedup', () => {
  beforeEach(() => {
    clearDedupCacheForTest();
  });

  it('returns null for unknown key', () => {
    expect(checkDedup('never-seen')).toBeNull();
  });

  it('returns recorded id within window', () => {
    const now = 1_000_000;
    recordDedup('k', 'ntc_1', now);
    expect(checkDedup('k', now + DEDUP_WINDOW_MS - 1)).toBe('ntc_1');
  });

  it('returns null and cleans up after expiry', () => {
    const now = 1_000_000;
    recordDedup('k', 'ntc_1', now);
    expect(checkDedup('k', now + DEDUP_WINDOW_MS + 1)).toBeNull();
    expect(dedupCacheSizeForTest()).toBe(0);
  });

  it('overwrites prior id on re-record', () => {
    const now = 1_000_000;
    recordDedup('k', 'ntc_1', now);
    recordDedup('k', 'ntc_2', now);
    expect(checkDedup('k', now + 1)).toBe('ntc_2');
  });
});
