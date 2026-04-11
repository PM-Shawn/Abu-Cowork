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

  it('allows localhost (no guard triggers)', async () => {
    // This should pass the guards and then fail at the network layer (no server running).
    // We assert it does NOT return any of the guard error messages.
    const result = await httpFetchTool.execute({ url: 'http://localhost:1/nonexistent' });
    expect(result).not.toContain('URL too long');
    expect(result).not.toContain('embedded credentials');
    expect(result).not.toContain('cloud metadata');
  });

  it('allows private network addresses (no guard triggers)', async () => {
    // Private IPs are NOT blocked — only cloud metadata endpoints are.
    // Local dev / internal services / Ollama etc. must remain accessible.
    const result = await httpFetchTool.execute({ url: 'http://192.168.1.1/' });
    expect(result).not.toContain('cloud metadata');
  });
});
