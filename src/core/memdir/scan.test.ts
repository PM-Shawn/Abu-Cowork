import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readTextFile, readDir } from '@tauri-apps/plugin-fs';
import { scanMemoryFiles, readMemoryFile, loadMemoryIndex, formatMemoryManifest } from './scan';
import { _resetCachedHome } from './paths';

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);

beforeEach(() => {
  vi.clearAllMocks();
  _resetCachedHome();
});

const VALID_FRONTMATTER = `---
name: Test memory
description: A test memory entry
type: feedback
source: agent_explicit
created: 1700000000000
updated: 1700000000000
accessCount: 3
---

This is the content body.`;

const MINIMAL_FRONTMATTER = `---
name: Minimal
type: user
---

Content here.`;

describe('scanMemoryFiles', () => {
  it('returns empty array when directory does not exist', async () => {
    mockReadDir.mockRejectedValueOnce(new Error('not found'));
    const result = await scanMemoryFiles(null);
    expect(result).toEqual([]);
  });

  it('skips MEMORY.md and non-md files', async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: 'MEMORY.md', isDirectory: false, isFile: true, isSymlink: false },
      { name: 'notes.txt', isDirectory: false, isFile: true, isSymlink: false },
      { name: 'feedback_test.md', isDirectory: false, isFile: true, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    mockReadTextFile.mockResolvedValueOnce(VALID_FRONTMATTER);

    const result = await scanMemoryFiles(null);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('feedback_test.md');
  });

  it('parses frontmatter correctly', async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: 'feedback_test.md', isDirectory: false, isFile: true, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    mockReadTextFile.mockResolvedValueOnce(VALID_FRONTMATTER);

    const result = await scanMemoryFiles(null);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Test memory');
    expect(result[0].description).toBe('A test memory entry');
    expect(result[0].type).toBe('feedback');
    expect(result[0].source).toBe('agent_explicit');
    expect(result[0].created).toBe(1700000000000);
    expect(result[0].accessCount).toBe(3);
  });

  it('defaults missing fields', async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: 'user_minimal.md', isDirectory: false, isFile: true, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    mockReadTextFile.mockResolvedValueOnce(MINIMAL_FRONTMATTER);

    const result = await scanMemoryFiles(null);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('user_manual'); // default
    expect(result[0].description).toBe('Minimal'); // falls back to name
  });

  it('skips files without name in frontmatter', async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: 'bad.md', isDirectory: false, isFile: true, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    mockReadTextFile.mockResolvedValueOnce('---\ntype: user\n---\nno name');

    const result = await scanMemoryFiles(null);
    expect(result).toHaveLength(0);
  });

  it('sorts by updated time descending', async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: 'old.md', isDirectory: false, isFile: true, isSymlink: false },
      { name: 'new.md', isDirectory: false, isFile: true, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    mockReadTextFile
      .mockResolvedValueOnce('---\nname: Old\nupdated: 1000\n---\nold')
      .mockResolvedValueOnce('---\nname: New\nupdated: 2000\n---\nnew');

    const result = await scanMemoryFiles(null);
    expect(result[0].name).toBe('New');
    expect(result[1].name).toBe('Old');
  });
});

describe('readMemoryFile', () => {
  it('returns header and body content', async () => {
    mockReadTextFile.mockResolvedValueOnce(VALID_FRONTMATTER);
    const result = await readMemoryFile('/mock/feedback_test.md');
    expect(result).not.toBeNull();
    expect(result!.header.name).toBe('Test memory');
    expect(result!.content).toBe('This is the content body.');
  });

  it('returns null for files without frontmatter name', async () => {
    mockReadTextFile.mockResolvedValueOnce('just plain text');
    const result = await readMemoryFile('/mock/bad.md');
    expect(result).toBeNull();
  });

  it('returns null when file is unreadable', async () => {
    mockReadTextFile.mockRejectedValueOnce(new Error('not found'));
    const result = await readMemoryFile('/mock/missing.md');
    expect(result).toBeNull();
  });
});

describe('loadMemoryIndex', () => {
  it('returns MEMORY.md content', async () => {
    mockReadTextFile.mockResolvedValueOnce('# Memory Index\n- test.md');
    const result = await loadMemoryIndex(null);
    expect(result).toBe('# Memory Index\n- test.md');
  });

  it('returns empty string when file does not exist', async () => {
    mockReadTextFile.mockRejectedValueOnce(new Error('not found'));
    const result = await loadMemoryIndex(null);
    expect(result).toBe('');
  });
});

describe('formatMemoryManifest', () => {
  it('formats headers as manifest lines', () => {
    const headers = [
      {
        filename: 'feedback_test.md', filePath: '/mock/feedback_test.md',
        name: 'Test', description: 'A test', type: 'feedback' as const,
        source: 'agent_explicit' as const, created: 1700000000000, updated: 1700000000000,
        accessCount: 0, private: false,
      },
    ];
    const result = formatMemoryManifest(headers);
    expect(result).toContain('[feedback]');
    expect(result).toContain('feedback_test.md');
    expect(result).toContain('A test');
  });
});

describe('private field parsing', () => {
  it('parses private: true', async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: 'private_test.md', isDirectory: false, isFile: true, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    mockReadTextFile.mockResolvedValueOnce(`---
name: Secret
type: reference
private: true
---
secret content`);

    const result = await scanMemoryFiles(null);
    expect(result).toHaveLength(1);
    expect(result[0].private).toBe(true);
  });

  it('defaults private to false when missing', async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: 'plain.md', isDirectory: false, isFile: true, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    mockReadTextFile.mockResolvedValueOnce(MINIMAL_FRONTMATTER);

    const result = await scanMemoryFiles(null);
    expect(result[0].private).toBe(false);
  });

  it('treats private: false as false', async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: 'plain.md', isDirectory: false, isFile: true, isSymlink: false },
    ] as Awaited<ReturnType<typeof readDir>>);
    mockReadTextFile.mockResolvedValueOnce(`---
name: Plain
type: user
private: false
---
content`);

    const result = await scanMemoryFiles(null);
    expect(result[0].private).toBe(false);
  });
});
