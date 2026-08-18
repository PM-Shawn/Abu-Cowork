import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

const mocks = vi.hoisted(() => ({
  scanMemoryFiles: vi.fn(),
  readMemoryFile: vi.fn(),
  invalidateScanCache: vi.fn(),
  writeMemory: vi.fn().mockResolvedValue('x.md'),
}));

vi.mock('./scan', () => ({
  scanMemoryFiles: mocks.scanMemoryFiles,
  readMemoryFile: mocks.readMemoryFile,
  invalidateScanCache: mocks.invalidateScanCache,
}));
vi.mock('./write', () => ({
  writeMemory: mocks.writeMemory,
}));

import { sweepMemorySecrets } from './secretSweep';
import { _resetCachedHome } from './paths';

const mockExists = vi.mocked(exists);
const mockInvoke = vi.mocked(invoke);
const mockReadTextFile = vi.mocked(readTextFile);

function header(filename: string, description: string) {
  return {
    filename,
    filePath: `/home/.abu/memory/${filename}`,
    name: filename.replace('.md', ''),
    description,
    type: 'user' as const,
    source: 'agent_explicit' as const,
    created: 1,
    updated: 1,
    accessCount: 0,
    private: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCachedHome();
  mockExists.mockResolvedValue(false); // marker absent by default
  mockInvoke.mockResolvedValue(undefined);
  mockReadTextFile.mockRejectedValue(new Error('not found')); // no index by default
  mocks.writeMemory.mockResolvedValue('x.md');
});

describe('sweepMemorySecrets', () => {
  it('is a no-op when the marker exists', async () => {
    mockExists.mockResolvedValue(true);
    const result = await sweepMemorySecrets(null);
    expect(result).toBeNull();
    expect(mocks.scanMemoryFiles).not.toHaveBeenCalled();
  });

  it('rewrites only files with credential-shaped content, then writes the marker', async () => {
    mocks.scanMemoryFiles.mockResolvedValue([
      header('user_mimo.md', '自定义端点配置'),
      header('user_clean.md', '偏好简短回复'),
    ]);
    mocks.readMemoryFile.mockImplementation(async (path: string) => {
      if (path.includes('mimo')) {
        return {
          header: header('user_mimo.md', 'API Key:tp-fak3key0fak3key1xyz'),
          content: '端点 https://x.com/v1,API Key:tp-fak3key0fak3key1xyz',
        };
      }
      return { header: header('user_clean.md', '偏好简短回复'), content: '喜欢简短回答。' };
    });

    const result = await sweepMemorySecrets(null);
    expect(result).toEqual({ scanned: 2, redactedFiles: ['user_mimo.md'] });

    // Only the dirty file is rewritten, through the normal funnel, in place.
    expect(mocks.writeMemory).toHaveBeenCalledTimes(1);
    const call = mocks.writeMemory.mock.calls[0][0];
    expect(call.filename).toBe('user_mimo.md');
    expect(call.description).toContain('[REDACTED:credential]');
    expect(call.content).not.toContain('tp-fak3key0fak3key1xyz');
    expect(call.bypassScan).toBe(true);
    // Hygiene rewrite, not an edit: original metadata must survive so the
    // swept file doesn't suddenly look freshly updated to staleness warnings,
    // recency scoring, and eviction order.
    expect(call.created).toBe(1);
    expect(call.updated).toBe(1);
    expect(call.accessCount).toBe(0);

    // Marker written so the sweep never re-runs.
    const marker = mockInvoke.mock.calls.find(
      ([cmd, args]) => cmd === 'atomic_write_text' && (args as { path: string }).path.includes('.secret-sweep-v1'),
    );
    expect(marker).toBeDefined();
    expect(mocks.invalidateScanCache).toHaveBeenCalled();
  });

  it('sanitizes credential-shaped bytes left in the index itself (orphan / foreign-format lines)', async () => {
    // Per-file rewrites can't reach index lines whose file no longer exists
    // (or whose label format the replace logic doesn't match) — the sweep's
    // final index pass must catch those, since MEMORY.md is injected into
    // every conversation's system prompt.
    mocks.scanMemoryFiles.mockResolvedValue([]);
    mockReadTextFile.mockImplementation(async (p: string | URL) => {
      if (String(p).endsWith('MEMORY.md')) {
        return '# Memory Index\n\n- [已删除的旧档](gone.md) — API Key:tp-fak3key0fak3key1xyz\n';
      }
      throw new Error('not found');
    });

    const result = await sweepMemorySecrets(null);
    expect(result?.redactedFiles).toEqual(['MEMORY.md']);
    const indexWrite = mockInvoke.mock.calls.find(
      ([cmd, args]) => cmd === 'atomic_write_text' && (args as { path: string }).path.endsWith('MEMORY.md'),
    );
    expect(indexWrite).toBeDefined();
    const written = (indexWrite![1] as { content: string }).content;
    expect(written).toContain('[REDACTED:credential]');
    expect(written).not.toContain('tp-fak3key0fak3key1xyz');
  });

  it('survives a single unreadable file and still finishes the sweep', async () => {
    mocks.scanMemoryFiles.mockResolvedValue([
      header('broken.md', 'x'),
      header('user_key.md', 'token=abc123def456ghi'),
    ]);
    mocks.readMemoryFile.mockImplementation(async (path: string) => {
      if (path.includes('broken')) throw new Error('EACCES');
      return { header: header('user_key.md', 'token=abc123def456ghi'), content: 'ok' };
    });

    const result = await sweepMemorySecrets(null);
    expect(result?.redactedFiles).toEqual(['user_key.md']);
  });
});
