import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkL2Quota,
  consumeL2Quota,
  clearQuotaForTest,
  L2_WINDOW_MS,
  L2_QUOTA,
} from './quota';

describe('L2 Quota (sliding window)', () => {
  beforeEach(() => {
    clearQuotaForTest();
  });

  it('allows up to L2_QUOTA deliveries within the window', () => {
    const now = 1_000_000;
    for (let i = 0; i < L2_QUOTA; i++) {
      expect(checkL2Quota(now + i)).toBe(true);
      consumeL2Quota(now + i);
    }
    expect(checkL2Quota(now + L2_QUOTA)).toBe(false);
  });

  it('rejects when quota exhausted within window', () => {
    const now = 1_000_000;
    consumeL2Quota(now);
    consumeL2Quota(now + 1000);
    consumeL2Quota(now + 2000);
    expect(checkL2Quota(now + 3000)).toBe(false);
  });

  it('slides window — old entries expire and free quota', () => {
    const now = 1_000_000;
    consumeL2Quota(now);
    consumeL2Quota(now + 1000);
    consumeL2Quota(now + 2000);

    const afterWindow = now + L2_WINDOW_MS + 1;
    expect(checkL2Quota(afterWindow)).toBe(true);
  });

  it('partial expiry — only oldest entries slide out', () => {
    const base = 1_000_000;
    consumeL2Quota(base);
    consumeL2Quota(base + 100_000);
    consumeL2Quota(base + 200_000);

    // After first entry expires but second/third still in window
    const t = base + L2_WINDOW_MS + 1;
    expect(checkL2Quota(t)).toBe(true);
    consumeL2Quota(t);
    // Now 2 still in window + 1 new = 3 → full
    expect(checkL2Quota(t + 1)).toBe(false);
  });

  it('empty state always allows', () => {
    expect(checkL2Quota(1_000_000)).toBe(true);
  });
});
