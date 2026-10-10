import { describe, it, expect, vi } from 'vitest';
import {
  normalizeSeparators,
  normalizeLexicalPath,
  getBaseName,
  getParentDir,
  joinPath,
  extractUsername,
  ensureParentDir,
} from './pathUtils';

describe('pathUtils', () => {
  // ── normalizeSeparators ──
  describe('normalizeSeparators', () => {
    it('converts backslashes to forward slashes', () => {
      expect(normalizeSeparators('C:\\Users\\alice\\file.txt')).toBe('C:/Users/alice/file.txt');
    });

    it('leaves forward slashes unchanged', () => {
      expect(normalizeSeparators('/Users/alice/file.txt')).toBe('/Users/alice/file.txt');
    });

    it('handles mixed separators', () => {
      expect(normalizeSeparators('C:\\Users/alice\\file.txt')).toBe('C:/Users/alice/file.txt');
    });

    it('handles empty string', () => {
      expect(normalizeSeparators('')).toBe('');
    });
  });

  // ── getBaseName ──
  describe('getBaseName', () => {
    it('returns filename from Unix path', () => {
      expect(getBaseName('/Users/alice/file.txt')).toBe('file.txt');
    });

    it('returns filename from Windows path', () => {
      expect(getBaseName('C:\\Users\\alice\\file.txt')).toBe('file.txt');
    });

    it('returns folder name', () => {
      expect(getBaseName('/Users/alice/projects')).toBe('projects');
    });

    it('handles trailing slash', () => {
      expect(getBaseName('/Users/alice/')).toBe('alice');
    });

    it('handles single segment', () => {
      expect(getBaseName('file.txt')).toBe('file.txt');
    });

    it('handles root path', () => {
      expect(getBaseName('/')).toBe('/');
    });
  });

  // ── getParentDir ──
  describe('getParentDir', () => {
    it('returns parent from Unix path', () => {
      expect(getParentDir('/Users/alice/file.txt')).toBe('/Users/alice');
    });

    it('returns parent from Windows path', () => {
      expect(getParentDir('C:\\Users\\alice\\file.txt')).toBe('C:/Users/alice');
    });

    it('returns / for top-level path', () => {
      expect(getParentDir('/file.txt')).toBe('/');
    });

    it('returns / for root', () => {
      expect(getParentDir('/')).toBe('/');
    });
  });

  // ── joinPath ──
  describe('joinPath', () => {
    it('joins simple segments', () => {
      expect(joinPath('/Users', 'alice', 'file.txt')).toBe('/Users/alice/file.txt');
    });

    it('removes double slashes', () => {
      expect(joinPath('/Users/', '/alice/', '/file.txt')).toBe('/Users/alice/file.txt');
    });

    it('normalizes backslashes', () => {
      expect(joinPath('C:\\Users', 'alice')).toBe('C:/Users/alice');
    });

    it('handles single segment', () => {
      expect(joinPath('/Users')).toBe('/Users');
    });

    it('handles empty segments', () => {
      expect(joinPath('/Users', '', 'file.txt')).toBe('/Users/file.txt');
    });
  });

  // ── extractUsername ──
  describe('extractUsername', () => {
    it('extracts from macOS home path', () => {
      expect(extractUsername('/Users/alice')).toBe('alice');
    });

    it('extracts from Windows home path', () => {
      expect(extractUsername('C:\\Users\\alice')).toBe('alice');
    });

    it('extracts from Linux home path', () => {
      expect(extractUsername('/home/alice')).toBe('alice');
    });

    it('handles trailing slash', () => {
      expect(extractUsername('/Users/alice/')).toBe('alice');
    });

    it('returns "user" for empty input', () => {
      expect(extractUsername('')).toBe('user');
    });
  });

  // ── normalizeLexicalPath ──
  describe('normalizeLexicalPath', () => {
    it('removes `.` segments and duplicate separators', () => {
      expect(normalizeLexicalPath('/ws/./out//report.md')).toBe('/ws/out/report.md');
    });

    it('resolves `..` segments', () => {
      expect(normalizeLexicalPath('/ws/sub/../report.md')).toBe('/ws/report.md');
    });

    it('does not climb above the root of an absolute path', () => {
      expect(normalizeLexicalPath('/../../etc/hosts')).toBe('/etc/hosts');
    });

    it('keeps a Windows drive letter as written', () => {
      expect(normalizeLexicalPath('c:\\ws\\.\\sub\\..\\a.docx')).toBe('c:/ws/a.docx');
      expect(normalizeLexicalPath('C:/../a.docx')).toBe('C:/a.docx');
    });

    it('keeps a UNC prefix', () => {
      expect(normalizeLexicalPath('\\\\server\\share\\.\\a.docx')).toBe('//server/share/a.docx');
    });

    it('keeps the leading `..` segments of a relative path', () => {
      expect(normalizeLexicalPath('../a/./b')).toBe('../a/b');
    });

    it('leaves a clean path unchanged', () => {
      expect(normalizeLexicalPath('/ws/报告 终稿.md')).toBe('/ws/报告 终稿.md');
    });
  });
});

describe('ensureParentDir under concurrency', () => {
  // Regression (TESTING.md §3 "Mocked modules must not be `await import()`ed
  // concurrently"): two parallel callers from this one module used to race a
  // dynamic `import('@tauri-apps/plugin-fs')`; vitest served the second one the
  // REAL plugin, which threw `window is not defined` from Tauri's invoke().
  it('routes every concurrent call through the setup.ts plugin-fs mock', async () => {
    const { mkdir } = await import('@tauri-apps/plugin-fs');
    vi.mocked(mkdir).mockClear();

    await Promise.all([
      ensureParentDir('/tmp/abu-a/one.txt'),
      ensureParentDir('/tmp/abu-b/two.txt'),
    ]);

    expect(vi.mocked(mkdir).mock.calls.map(([dir]) => dir).sort()).toEqual(['/tmp/abu-a', '/tmp/abu-b']);
  });
});
