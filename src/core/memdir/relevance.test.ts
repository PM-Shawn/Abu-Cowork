import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readTextFile, readDir } from '@tauri-apps/plugin-fs';
import {
  findRelevantMemories,
  formatRelevantMemoriesSection,
  extractQueryText,
  MAX_PER_MEMORY_BYTES,
  MAX_TURN_BYTES,
} from './relevance';
import { _resetCachedHome } from './paths';
import { _resetScanCache } from './scan';

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

function makeFile(opts: {
  name: string;
  description: string;
  type?: string;
  updated?: number;
  isPrivate?: boolean;
  body?: string;
}): string {
  return `---
name: ${opts.name}
description: ${opts.description}
type: ${opts.type ?? 'user'}
source: agent_explicit
created: ${opts.updated ?? NOW}
updated: ${opts.updated ?? NOW}
accessCount: 0
private: ${opts.isPrivate ? 'true' : 'false'}
---

${opts.body ?? 'body content'}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  _resetCachedHome();
  _resetScanCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('extractQueryText', () => {
  it('returns null for empty / very short queries', () => {
    expect(extractQueryText('')).toBe(null);
    expect(extractQueryText('好')).toBe(null);
    expect(extractQueryText('   ')).toBe(null);
  });

  it('returns null for short single-word queries', () => {
    expect(extractQueryText('ok')).toBe(null);
    expect(extractQueryText('继续')).toBe(null);
  });

  it('passes multi-word queries', () => {
    expect(extractQueryText('我叫什么')).toBe('我叫什么');
    expect(extractQueryText('what is my name')).toBe('what is my name');
  });

  it('passes long single tokens', () => {
    expect(extractQueryText('whatistheanswer')).toBe('whatistheanswer');
  });
});

describe('findRelevantMemories', () => {
  it('returns empty when no memories exist', async () => {
    mockReadDir.mockResolvedValueOnce([]);
    const result = await findRelevantMemories('test', null);
    expect(result).toEqual([]);
  });

  it('excludes private memories from injection', async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: 'public.md', isFile: true, isDirectory: false, isSymlink: false },
      { name: 'private.md', isFile: true, isDirectory: false, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    mockReadTextFile
      .mockResolvedValueOnce(makeFile({ name: 'Public memory', description: 'public stuff' }))
      .mockResolvedValueOnce(makeFile({ name: 'Private memory', description: 'secret', isPrivate: true }))
      // Body reads for selected memories:
      .mockResolvedValueOnce(makeFile({ name: 'Public memory', description: 'public stuff' }));

    const result = await findRelevantMemories('public stuff', null);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Public memory');
  });

  it('scores name matches higher than description matches', async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: 'a.md', isFile: true, isDirectory: false, isSymlink: false },
      { name: 'b.md', isFile: true, isDirectory: false, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    // a: keyword in description only
    // b: keyword in name (should rank higher)
    mockReadTextFile
      .mockResolvedValueOnce(makeFile({ name: 'Other', description: 'mentions banana' }))
      .mockResolvedValueOnce(makeFile({ name: 'banana fact', description: 'fruit info' }))
      // Body reads:
      .mockResolvedValueOnce(makeFile({ name: 'banana fact', description: 'fruit info', body: 'B body' }))
      .mockResolvedValueOnce(makeFile({ name: 'Other', description: 'mentions banana', body: 'A body' }));

    const result = await findRelevantMemories('banana information', null);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].name).toBe('banana fact');
  });

  it('falls back to recency when no keyword matches', async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: 'old.md', isFile: true, isDirectory: false, isSymlink: false },
      { name: 'new.md', isFile: true, isDirectory: false, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    mockReadTextFile
      .mockResolvedValueOnce(makeFile({ name: 'Old', description: 'old', updated: NOW - 100 * DAY }))
      .mockResolvedValueOnce(makeFile({ name: 'New', description: 'new', updated: NOW - 1 * DAY }))
      // Body reads (sorted by updated desc):
      .mockResolvedValueOnce(makeFile({ name: 'New', description: 'new', updated: NOW - 1 * DAY }))
      .mockResolvedValueOnce(makeFile({ name: 'Old', description: 'old', updated: NOW - 100 * DAY }));

    // Query has zero keyword matches
    const result = await findRelevantMemories('completely unrelated query xyzzy', null);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toBe('New');
  });

  it('truncates oversized memory bodies', async () => {
    const big = 'X'.repeat(MAX_PER_MEMORY_BYTES * 2);
    mockReadDir.mockResolvedValueOnce([
      { name: 'big.md', isFile: true, isDirectory: false, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    mockReadTextFile
      .mockResolvedValueOnce(makeFile({ name: 'Big', description: 'huge', body: big }))
      .mockResolvedValueOnce(makeFile({ name: 'Big', description: 'huge', body: big }));

    const result = await findRelevantMemories('huge memory', null);
    expect(result).toHaveLength(1);
    expect(result[0].truncated).toBe(true);
    expect(result[0].content.length).toBeLessThanOrEqual(MAX_PER_MEMORY_BYTES + 100); // allow truncation marker
  });

  it('respects MAX_TURN_BYTES across multiple memories', async () => {
    // 10 memories each ~3KB → only some fit under 20KB cap
    const entries = Array.from({ length: 10 }, (_, i) => ({
      name: `${i}.md`,
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    }));
    mockReadDir.mockResolvedValueOnce(entries as Awaited<ReturnType<typeof readDir>>);
    const body = 'Y'.repeat(3000);
    // Once for each scan-time read (header parse), once for each readMemoryFile
    for (let i = 0; i < 10; i++) {
      mockReadTextFile.mockResolvedValueOnce(makeFile({ name: `Mem ${i}`, description: `relevant ${i}`, body }));
    }
    for (let i = 0; i < 10; i++) {
      mockReadTextFile.mockResolvedValueOnce(makeFile({ name: `Mem ${i}`, description: `relevant ${i}`, body }));
    }

    const result = await findRelevantMemories('relevant memory', null);
    const total = result.reduce((sum, m) => sum + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TURN_BYTES);
  });
});

describe('formatRelevantMemoriesSection', () => {
  it('returns empty string for no memories', () => {
    expect(formatRelevantMemoriesSection([])).toBe('');
  });

  it('wraps each memory in a <memory> block', () => {
    const out = formatRelevantMemoriesSection([
      {
        filename: 'a.md', filePath: '/x/a.md',
        type: 'user', name: 'Alice', updated: NOW, content: 'hello',
        truncated: false,
      },
    ]);
    expect(out).toContain('<memory filename="a.md"');
    expect(out).toContain('type="user"');
    expect(out).toContain('hello');
    expect(out).toContain('</memory>');
  });

  it('adds staleness warning for old memories', () => {
    const out = formatRelevantMemoriesSection([
      {
        filename: 'old.md', filePath: '/x/old.md',
        type: 'project', name: 'Old', updated: NOW - 100 * DAY,
        content: 'old facts', truncated: false,
      },
    ]);
    expect(out).toContain('100 天未更新');
  });

  it('does not warn on fresh memories', () => {
    const out = formatRelevantMemoriesSection([
      {
        filename: 'fresh.md', filePath: '/x/fresh.md',
        type: 'user', name: 'Fresh', updated: NOW - 5 * DAY,
        content: 'recent', truncated: false,
      },
    ]);
    expect(out).not.toContain('天未更新');
  });
});
