/**
 * Tests for `authorizedPathsReaderRun.ts` (P1-3d-5 slice 2a) — the sidecar
 * reverse-RPC reader behind `run_command`'s sandbox authorized-paths query.
 * Same mocking pattern as `aiEditSnapshotsRun.test.ts` (mock `../rpcClient`).
 *
 * SAFETY-RELEVANT contract under test (2026-07-26 review remediation): the
 * reader must fail CLOSED on a malformed (resolved but non-array) RPC result
 * — coercing to [] would silently under-authorize the OS sandbox, the exact
 * outcome `localTools/index.ts`'s fail-closed doc block rules out. A rejected
 * RPC already fails closed by propagating the rejection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as rpcClient from '../rpcClient';
import { getAuthorizedPathsReader, setAuthorizedPathsReader } from './authorizedPathsReaderRun';

vi.mock('../rpcClient', () => ({
  sendRequest: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(rpcClient.sendRequest).mockReset();
});

describe('authorizedPathsReaderRun shim', () => {
  it('returns the array result from workspace.authorizedWritablePaths', async () => {
    vi.mocked(rpcClient.sendRequest).mockResolvedValue(['/a', '/b']);
    await expect(getAuthorizedPathsReader().getAuthorizedWritablePaths()).resolves.toEqual([
      '/a',
      '/b',
    ]);
    expect(rpcClient.sendRequest).toHaveBeenCalledWith('workspace.authorizedWritablePaths', {});
  });

  it('fails closed (throws) on a malformed non-array result instead of coercing to []', async () => {
    vi.mocked(rpcClient.sendRequest).mockResolvedValue(undefined);
    await expect(getAuthorizedPathsReader().getAuthorizedWritablePaths()).rejects.toThrow(
      /non-array/,
    );
  });

  it('propagates a rejected RPC (fail closed, no swallow)', async () => {
    vi.mocked(rpcClient.sendRequest).mockRejectedValue(new Error('transport down'));
    await expect(getAuthorizedPathsReader().getAuthorizedWritablePaths()).rejects.toThrow(
      'transport down',
    );
  });

  it('setAuthorizedPathsReader throws (wiring-bug guard, mirrors workspaceReaderRun)', () => {
    expect(() =>
      setAuthorizedPathsReader({ getAuthorizedWritablePaths: async () => [] }),
    ).toThrow(/wiring bug/);
  });
});
