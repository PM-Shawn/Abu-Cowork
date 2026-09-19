import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, mkdir, readDir, readTextFile, remove, stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { loadConversationWriterFixtures, replayWriterFixture } from '@/test/conversationWriterFixtures';

const ROOT = '/Users/testuser/.abu/conversations';

function installMemoryFs(): Map<string, string> {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const write = (path: string, content: string): void => {
    files.set(path, content);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  };
  vi.mocked(exists).mockImplementation(async (path) => files.has(String(path)) || dirs.has(String(path)));
  vi.mocked(readTextFile).mockImplementation(async (path) => {
    const content = files.get(String(path));
    if (content === undefined) throw new Error(`File not found: ${String(path)}`);
    return content;
  });
  vi.mocked(mkdir).mockImplementation(async (path) => { dirs.add(String(path)); });
  vi.mocked(remove).mockImplementation(async (path) => {
    for (const key of [...files.keys()]) if (key.startsWith(String(path))) files.delete(key);
    dirs.delete(String(path));
  });
  vi.mocked(readDir).mockImplementation(async () => []);
  vi.mocked(stat).mockImplementation(async (path) => (
    { size: new TextEncoder().encode(files.get(String(path)) ?? '').byteLength } as Awaited<ReturnType<typeof stat>>
  ));
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as { path?: string; content?: string; data?: string };
    if (cmd === 'atomic_write_text' && a.path !== undefined) { write(a.path, a.content ?? ''); return undefined; }
    if (cmd === 'append_file_text' && a.path !== undefined) { write(a.path, (files.get(a.path) ?? '') + (a.data ?? '')); return undefined; }
    return undefined;
  });
  return files;
}

describe('conversationStorage writes the bytes the shared fixtures record', () => {
  let files: Map<string, string>;

  beforeEach(() => {
    files = installMemoryFs();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const testCase of loadConversationWriterFixtures()) {
    it(testCase.name, async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: testCase.now });
      // `Math.random().toString(36).substring(2, 8)` must yield the case's suffix: 0.5 → "i".
      expect(testCase.randomSuffix).toBe('i');
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const storage = await import('./conversationStorage');
      const mismatches = await replayWriterFixture(
        testCase,
        storage,
        async (relativePath) => files.get(`${ROOT}/${relativePath}`) ?? null,
      );
      expect(mismatches).toEqual([]);
    });
  }
});
