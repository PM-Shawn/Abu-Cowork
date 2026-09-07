import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { fetchRemotePluginSource } from './remoteFetch';
import type { PluginSource } from './marketplace';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => vi.clearAllMocks());

describe('fetchRemotePluginSource', () => {
  it('invokes the privileged command with the source and destination', async () => {
    mockInvoke.mockResolvedValue({ destDir: '/pkgs/r', sha: 'abc' });
    const source: PluginSource = { kind: 'url', url: 'https://github.com/o/r.git', sha: 'abc' };

    const result = await fetchRemotePluginSource(source, '/pkgs/r');

    expect(mockInvoke).toHaveBeenCalledWith('plugin_git_fetch', { source, destDir: '/pkgs/r' });
    expect(result).toEqual({ destDir: '/pkgs/r', sha: 'abc' });
  });

  it('propagates a privileged-side rejection (e.g. sha mismatch)', async () => {
    mockInvoke.mockRejectedValue(new Error('sha mismatch: declared abc, got def'));
    await expect(
      fetchRemotePluginSource({ kind: 'url', url: 'https://x/y.git', sha: 'abc' }, '/pkgs/r'),
    ).rejects.toThrow(/sha mismatch/);
  });
});
