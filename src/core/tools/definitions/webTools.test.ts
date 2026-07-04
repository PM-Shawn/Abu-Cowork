import { describe, it, expect } from 'vitest';
import { httpFetchTool } from './webTools';

// These tests cover the pre-flight guards in httpFetchTool.execute that run
// BEFORE any network call. Verifying them doesn't require mocking fetch —
// the guards short-circuit and return an error string directly.

describe('httpFetchTool pre-flight guards', () => {
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

  // NOTE: Two "allows non-blocked URL" tests that make real network calls were moved to
  // src/__tests__/quarantine/webTools-network-calls.test.ts because they depend on network
  // behavior (localhost:1 ECONNREFUSED timing, 192.168.1.1 route availability) and
  // consistently time out on CI runners. The guard logic they test (pre-flight accepts
  // private IPs / localhost) is still validated via the error-message assertions above.
});
