import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpFetchTool } from './webTools';
import { getTauriFetch } from '../../llm/tauriFetch';

// These tests cover the pre-flight guards in httpFetchTool.execute that run
// BEFORE any network call. Verifying them doesn't require mocking fetch —
// the guards short-circuit and return an error string directly.

// getTauriFetch() itself is mocked (rather than spying on globalThis.fetch)
// because it memoizes its result in a module-level singleton (_loadPromise in
// src/core/llm/tauriFetch.ts) that is shared for the lifetime of this test
// file. A per-test globalThis.fetch spy set up after that singleton first
// resolves would be ignored by later tests; mocking the wrapper module
// sidesteps that entirely and lets each test control its own stub.
vi.mock('../../llm/tauriFetch', () => ({
  getTauriFetch: vi.fn(),
}));

describe('httpFetchTool pre-flight guards', () => {
  it('is never classified as replay-safe because it supports mutating HTTP methods', () => {
    expect(httpFetchTool.isConcurrencySafe).toBe(false);
  });

  it('rejects URL longer than 2000 chars', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2100);
    const result = await httpFetchTool.execute({ url: longUrl });
    expect(result).toContain('URL too long');
  });

  it('rejects invalid URL', async () => {
    const result = await httpFetchTool.execute({ url: 'not a url' });
    expect(result).toContain('invalid URL');
  });

  it('rejects URL with embedded credentials', async () => {
    const result = await httpFetchTool.execute({
      url: 'https://admin:secret@internal.example.com/api',
    });
    expect(result).toContain('embedded credentials');
  });

  it('blocks AWS/Azure metadata endpoint', async () => {
    const result = await httpFetchTool.execute({ url: 'http://169.254.169.254/latest/meta-data/' });
    expect(result).toContain('cloud metadata');
  });

  it('blocks GCP metadata endpoint', async () => {
    const result = await httpFetchTool.execute({ url: 'http://metadata.google.internal/computeMetadata/v1/' });
    expect(result).toContain('cloud metadata');
  });

  it('blocks Alibaba Cloud metadata endpoint', async () => {
    const result = await httpFetchTool.execute({ url: 'http://100.100.100.200/latest/meta-data/' });
    expect(result).toContain('cloud metadata');
  });

  // NOTE: Two "allows non-blocked URL" tests that made REAL network calls (localhost:1,
  // 192.168.1.1) were quarantined in 2026-06 and deleted in 2026-09 when they exceeded the
  // 4-week SLA: real network is forbidden by TESTING.md §3. Acceptance of localhost/private
  // IPs (i.e. the guard does NOT block them) is now covered by the mocked-fetch tests below,
  // not by the blocking assertions above — those only prove metadata endpoints are rejected.
});

describe('httpFetchTool pre-flight guards — acceptance (mocked fetch, no real network)', () => {
  // Replaces the deleted quarantine/webTools-network-calls.test.ts tests with a deterministic
  // equivalent: assert the guard lets the request THROUGH to the fetch layer (by stubbing it
  // and observing the stub was reached) instead of depending on real network timing.
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchStub = vi.fn().mockRejectedValue(new Error('E2E_STUB_REACHED'));
    vi.mocked(getTauriFetch).mockResolvedValue(fetchStub);
  });

  afterEach(() => {
    vi.mocked(getTauriFetch).mockReset();
  });

  it('lets a localhost URL through the pre-flight guard (fetch stub reached)', async () => {
    const result = await httpFetchTool.execute({ url: 'http://localhost:1/nonexistent' });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(result).toContain('E2E_STUB_REACHED');
    expect(result).not.toContain('cloud metadata');
    expect(result).not.toContain('blocked');
  });

  it('lets a private-network IP (192.168.1.1) through the pre-flight guard (fetch stub reached)', async () => {
    const result = await httpFetchTool.execute({ url: 'http://192.168.1.1/' });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(result).toContain('E2E_STUB_REACHED');
    expect(result).not.toContain('cloud metadata');
    expect(result).not.toContain('blocked');
  });
});
