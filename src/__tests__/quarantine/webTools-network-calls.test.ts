// QUARANTINED: https://github.com/PM-Shawn/Abu-Cowork/issues/100 (2026-06-30)
//
// These tests verify that httpFetchTool passes the pre-flight guards for private IPs /
// localhost (i.e., the tool does NOT block them), but they do so by making REAL network
// calls rather than mocking the HTTP layer. In environments where:
//   - localhost:1 takes > 5s to return ECONNREFUSED (e.g., some macOS firewall configs)
//   - 192.168.1.1 is unreachable (no router at that IP, packet dropped, TCP timeout ~75s)
// these tests time out and fail the gate.
//
// Fix: mock the HTTP fetch layer (e.g., globalThis.fetch spy) so the test asserts on
// guard behavior only, without making real network calls. Once mocked, move back to
// webTools.test.ts.
//
// SLA: Fix by 2026-07-28.

import { describe, it, expect } from 'vitest';
import { httpFetchTool } from '@/core/tools/definitions/webTools';

describe('httpFetchTool · non-blocked URLs (network-dependent, quarantined)', () => {
  it('allows localhost (no guard triggers — real network call)', async () => {
    // This test makes a real TCP connection to localhost:1.
    // Fast on most machines (immediate ECONNREFUSED), but can time out if the OS
    // defers the refusal (e.g., under firewall rules that DROP rather than REJECT).
    const result = await httpFetchTool.execute({ url: 'http://localhost:1/nonexistent' });
    expect(result).not.toContain('URL too long');
    expect(result).not.toContain('embedded credentials');
    expect(result).not.toContain('cloud metadata');
  }, 10000); // 10s timeout: ECONNREFUSED should be near-instant, but give headroom

  it('allows private network addresses (no guard triggers — real network call)', async () => {
    // Private IPs are NOT blocked by the pre-flight guard — only cloud metadata endpoints are.
    // This test makes a real TCP connection to 192.168.1.1. If that IP has no router or
    // the packet is dropped (not rejected), this hits the OS TCP timeout (~75s on macOS)
    // and fails the 5s Vitest default.
    const result = await httpFetchTool.execute({ url: 'http://192.168.1.1/' });
    expect(result).not.toContain('cloud metadata');
  }, 10000);
});
