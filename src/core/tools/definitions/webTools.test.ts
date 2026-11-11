import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpFetchTool } from './webTools';
import { getTauriFetch } from '../../llm/tauriFetch';
import { boundToolResult } from '../../context/toolResultSpill';
import type { HttpFetchOutcome } from '../../../types';

// The blocking tests cover the pre-flight guards in httpFetchTool.execute that
// run BEFORE any network call; they need no mock — the guards short-circuit
// and return an error string directly. The acceptance tests below mock
// getTauriFetch so no real network is touched.

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
    fetchStub = vi.fn().mockRejectedValue(new Error('FETCH_STUB_REACHED'));
    vi.mocked(getTauriFetch).mockResolvedValue(fetchStub);
  });

  afterEach(() => {
    vi.mocked(getTauriFetch).mockReset();
  });

  it('lets a localhost URL through the pre-flight guard (fetch stub reached)', async () => {
    const result = await httpFetchTool.execute({ url: 'http://localhost:1/nonexistent' });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(result).toContain('FETCH_STUB_REACHED');
    expect(result).not.toContain('cloud metadata');
    expect(result).not.toContain('blocked');
  });

  it('lets a private-network IP (192.168.1.1) through the pre-flight guard (fetch stub reached)', async () => {
    const result = await httpFetchTool.execute({ url: 'http://192.168.1.1/' });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(result).toContain('FETCH_STUB_REACHED');
    expect(result).not.toContain('cloud metadata');
    expect(result).not.toContain('blocked');
  });
});

describe('http fetch outcome record', () => {
  const url = 'https://example.com/data';

  function respondWith(body: string, status = 200, statusText = 'OK'): void {
    const fetchStub = vi.fn().mockResolvedValue(new Response(body, {
      status,
      statusText,
      headers: { 'content-type': 'text/plain' },
    }));
    vi.mocked(getTauriFetch).mockResolvedValue(fetchStub);
  }

  /** The one `httpFetchOutcome` reported to `reportMetadata`. */
  function outcomeOf(reportMetadata: ReturnType<typeof vi.fn>): HttpFetchOutcome {
    expect(reportMetadata).toHaveBeenCalledTimes(1);
    return (reportMetadata.mock.calls[0][0] as { httpFetchOutcome: HttpFetchOutcome }).httpFetchOutcome;
  }

  afterEach(() => {
    vi.mocked(getTauriFetch).mockReset();
  });

  it('records the status and the body position', async () => {
    respondWith('hello\nworld');
    const reportMetadata = vi.fn();

    const result = await httpFetchTool.execute({ url }, { reportMetadata }) as string;

    expect(reportMetadata).toHaveBeenCalledWith({
      httpFetchOutcome: { status: 200, statusText: 'OK', body: [13, 24], truncated: false },
    });
    expect(result.slice(13, 24)).toBe('hello\nworld');
  });

  it('returns a long body whole, so the one spill keeps its tail reachable', async () => {
    const body = `FIRST\n${'x'.repeat(60000)}\nLAST`;
    respondWith(body);
    const reportMetadata = vi.fn();

    const result = await httpFetchTool.execute({ url }, { reportMetadata }) as string;

    const outcome = outcomeOf(reportMetadata);
    expect(outcome.truncated).toBe(false);
    expect(result.slice(...outcome.body)).toBe(body);

    const writeFile = vi.fn(async () => '/data/results/tc.txt');
    const bounded = await boundToolResult({ toolCallId: 'tc', toolName: 'http_fetch', input: {}, result, writeFile });
    expect(writeFile).toHaveBeenCalledWith('tc', result);
    expect(bounded).toContain('/data/results/tc.txt');
    expect(bounded).toContain('LAST');
  });

  it('keeps a short body whole', async () => {
    respondWith('hello');
    const reportMetadata = vi.fn();

    const result = await httpFetchTool.execute({ url }, { reportMetadata });

    expect(outcomeOf(reportMetadata).truncated).toBe(false);
    expect(result).toBe('HTTP 200 OK\n\nhello');
  });

  it('records a non-2xx status', async () => {
    respondWith('missing', 404, 'Not Found');
    const reportMetadata = vi.fn();

    await httpFetchTool.execute({ url }, { reportMetadata });

    expect(outcomeOf(reportMetadata).status).toBe(404);
  });

  it('records an empty status text', async () => {
    respondWith('missing', 404, '');
    const reportMetadata = vi.fn();

    await httpFetchTool.execute({ url }, { reportMetadata });

    const outcome = outcomeOf(reportMetadata);
    expect(outcome.statusText).toBe('');
    expect(outcome.body[0]).toBe('HTTP 404 '.length + 2);
  });

  it('records nothing when the request throws', async () => {
    vi.mocked(getTauriFetch).mockResolvedValue(vi.fn().mockRejectedValue(new Error('offline')));
    const reportMetadata = vi.fn();

    const result = await httpFetchTool.execute({ url }, { reportMetadata });

    expect(result).toContain('offline');
    expect(reportMetadata).not.toHaveBeenCalled();
  });
});
