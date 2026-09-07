/**
 * The file half of an upload (T5).
 *
 * The 2026-09-07 ruling moved the SITE question onto the same rails as a click
 * — the row, the site grant, the conversation grant, the IM target. It moved
 * nothing here. Whether Abu may read this path, whether it is a link, whether
 * it is too big: those are facts about a FILE, they are the same facts on every
 * release path including the silent one, and this file is where they are
 * pinned.
 *
 * `resolveUploadFiles` is pure by injection, so every case below is exact —
 * no filesystem, no `pathSafety` module state, no timing.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  decodeUploadFiles,
  displayName,
  formatBytes,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  resolveUploadFiles,
  summarizeUploadFiles,
  type BrowserUploadDeps,
} from './browserUploadFiles';

/** An authorized workspace that canonicalizes `~`-free absolute paths to themselves. */
function deps(overrides: Partial<BrowserUploadDeps> = {}): BrowserUploadDeps {
  return {
    checkReadPath: vi.fn(async (path: string) => ({ allowed: true, resolvedPath: path })),
    lstat: vi.fn(async () => ({ isFile: true, isSymlink: false, size: 1024 })),
    ...overrides,
  };
}

describe('decodeUploadFiles', () => {
  it('reads the JSON string the tool schema declares', () => {
    expect(decodeUploadFiles({ files: '[{"path":"/ws/a.txt"},{"path":"/ws/b.txt"}]' }))
      .toEqual(['/ws/a.txt', '/ws/b.txt']);
  });

  it('reads an already-decoded array too, the way decodeBatchSteps does', () => {
    expect(decodeUploadFiles({ files: [{ path: '/ws/a.txt' }] })).toEqual(['/ws/a.txt']);
  });

  it('accepts a bare string entry from a model that skipped the wrapper', () => {
    expect(decodeUploadFiles({ files: '["/ws/a.txt"]' })).toEqual(['/ws/a.txt']);
  });

  it('trims surrounding whitespace rather than passing a path with a stray space', () => {
    expect(decodeUploadFiles({ files: '["  /ws/a.txt  "]' })).toEqual(['/ws/a.txt']);
  });

  /**
   * The whole call, never the subset that parsed: a form that receives two of
   * the three attachments the user approved is a form they did not approve.
   */
  it.each([
    ['a non-array', '{"path":"/ws/a.txt"}'],
    ['an empty list', '[]'],
    ['unparseable JSON', '[{'],
    ['an entry with no path', '[{"name":"a.txt"}]'],
    ['an entry whose path is not a string', '[{"path":42}]'],
    ['an entry whose path is blank', '["   "]'],
    ['a nested array entry', '[["/ws/a.txt"]]'],
  ])('refuses the whole call for %s', (_label, files) => {
    expect(decodeUploadFiles({ files })).toBeNull();
  });

  it('refuses a call with no files argument at all', () => {
    expect(decodeUploadFiles({})).toBeNull();
    expect(decodeUploadFiles(undefined)).toBeNull();
  });

  it('refuses one good path mixed with one bad one — no partial upload', () => {
    expect(decodeUploadFiles({ files: '[{"path":"/ws/a.txt"},{"path":""}]' })).toBeNull();
  });
});

describe('resolveUploadFiles', () => {
  it('returns the CANONICAL path, the base name and the size the disk reports', async () => {
    const resolved = await resolveUploadFiles(
      { files: '[{"path":"/ws/../ws/报表 2026.xlsx"}]' },
      deps({
        checkReadPath: vi.fn(async () => ({ allowed: true, resolvedPath: '/ws/报表 2026.xlsx' })),
        lstat: vi.fn(async () => ({ isFile: true, isSymlink: false, size: 2048 })),
      }),
    );
    expect(resolved).toEqual({
      ok: true,
      files: [{ path: '/ws/报表 2026.xlsx', name: '报表 2026.xlsx', size: 2048 }],
    });
  });

  it('takes the base name off a Windows path rather than reporting the whole string', async () => {
    const resolved = await resolveUploadFiles(
      { files: '["C:\\\\Users\\\\me\\\\Documents\\\\排班表.xlsx"]' },
      deps({
        checkReadPath: vi.fn(async (p: string) => ({ allowed: true, resolvedPath: p })),
      }),
    );
    expect(resolved.ok && resolved.files[0].name).toBe('排班表.xlsx');
  });

  it('refuses a malformed files argument before it touches the filesystem', async () => {
    const d = deps();
    expect(await resolveUploadFiles({ files: '[]' }, d)).toEqual({ ok: false, code: 'malformed' });
    expect(d.checkReadPath).not.toHaveBeenCalled();
    expect(d.lstat).not.toHaveBeenCalled();
  });

  it('refuses more than one submission worth of files, and says how many were asked for', async () => {
    const many = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => ({ path: `/ws/${i}.txt` }));
    const d = deps();
    expect(await resolveUploadFiles({ files: JSON.stringify(many) }, d)).toEqual({
      ok: false, code: 'too-many-files', detail: String(MAX_UPLOAD_FILES + 1),
    });
    expect(d.checkReadPath).not.toHaveBeenCalled();
  });

  /**
   * The refusal that keeps «上传» from becoming «读任意文件». `checkReadPath`
   * is the app's own authorization, and a `false` from it ends the call — it
   * is deliberately NOT turned into a directory-authorization prompt, which
   * would buy a whole folder for the rest of the session.
   */
  it('refuses a path outside every authorized workspace, naming only the base name', async () => {
    const resolved = await resolveUploadFiles(
      { files: '["/Users/me/.ssh/id_rsa"]' },
      deps({ checkReadPath: vi.fn(async () => ({ allowed: false, reason: 'outside' })) }),
    );
    expect(resolved).toEqual({ ok: false, code: 'not-authorized', detail: 'id_rsa' });
  });

  it('refuses an ALLOWED check that came back without a resolved path — no falling back to the argument', async () => {
    const resolved = await resolveUploadFiles(
      { files: '["/ws/a.txt"]' },
      deps({ checkReadPath: vi.fn(async () => ({ allowed: true })) }),
    );
    expect(resolved).toEqual({ ok: false, code: 'not-authorized', detail: 'a.txt' });
  });

  /**
   * A link inside an authorized workspace pointing anywhere is the attack, and
   * it is invisible from the canonical path alone — so the path AS WRITTEN is
   * lstat'ed too. Both spellings are pinned, because a mutation that drops
   * either one leaves the other passing.
   */
  it('refuses a link the CALLER named, even though it canonicalizes into the workspace', async () => {
    const lstat = vi.fn(async (path: string) => (
      path === '/ws/link.txt'
        ? { isFile: true, isSymlink: true, size: 10 }
        : { isFile: true, isSymlink: false, size: 10 }
    ));
    const resolved = await resolveUploadFiles(
      { files: '["/ws/link.txt"]' },
      deps({
        checkReadPath: vi.fn(async () => ({ allowed: true, resolvedPath: '/ws/real.txt' })),
        lstat,
      }),
    );
    expect(resolved).toEqual({ ok: false, code: 'symlink', detail: 'link.txt' });
  });

  it('refuses a link at the CANONICAL path too', async () => {
    const lstat = vi.fn(async (path: string) => (
      path === '/ws/real.txt'
        ? { isFile: true, isSymlink: true, size: 10 }
        : { isFile: true, isSymlink: false, size: 10 }
    ));
    const resolved = await resolveUploadFiles(
      { files: '["/ws/link.txt"]' },
      deps({
        checkReadPath: vi.fn(async () => ({ allowed: true, resolvedPath: '/ws/real.txt' })),
        lstat,
      }),
    );
    expect(resolved).toEqual({ ok: false, code: 'symlink', detail: 'link.txt' });
  });

  it('refuses a directory, and anything else that is not an ordinary file', async () => {
    const resolved = await resolveUploadFiles(
      { files: '["/ws/folder"]' },
      deps({ lstat: vi.fn(async () => ({ isFile: false, isSymlink: false, size: 0 })) }),
    );
    expect(resolved).toEqual({ ok: false, code: 'not-a-file', detail: 'folder' });
  });

  it('reports a missing file as not-a-file rather than letting the lstat error escape', async () => {
    const resolved = await resolveUploadFiles(
      { files: '["/ws/gone.txt"]' },
      deps({ lstat: vi.fn(async () => { throw new Error('ENOENT'); }) }),
    );
    expect(resolved).toEqual({ ok: false, code: 'not-a-file', detail: 'gone.txt' });
  });

  it('accepts an empty file — zero bytes is a file, not an error', async () => {
    const resolved = await resolveUploadFiles(
      { files: '["/ws/empty.txt"]' },
      deps({ lstat: vi.fn(async () => ({ isFile: true, isSymlink: false, size: 0 })) }),
    );
    expect(resolved).toEqual({ ok: true, files: [{ path: '/ws/empty.txt', name: 'empty.txt', size: 0 }] });
  });

  it('refuses one file over the per-file ceiling', async () => {
    const resolved = await resolveUploadFiles(
      { files: '["/ws/huge.zip"]' },
      deps({ lstat: vi.fn(async () => ({ isFile: true, isSymlink: false, size: MAX_UPLOAD_FILE_BYTES + 1 })) }),
    );
    expect(resolved).toEqual({ ok: false, code: 'too-large', detail: 'huge.zip' });
  });

  it('accepts a file exactly at the per-file ceiling — the bound is inclusive', async () => {
    const resolved = await resolveUploadFiles(
      { files: '["/ws/exact.zip"]' },
      deps({ lstat: vi.fn(async () => ({ isFile: true, isSymlink: false, size: MAX_UPLOAD_FILE_BYTES })) }),
    );
    expect(resolved.ok).toBe(true);
  });

  /**
   * The per-CALL ceiling, which is the one a per-file check alone would miss:
   * three files each under the per-file bound can still be more than one
   * submission should carry.
   */
  it('refuses a call whose TOTAL is over the ceiling even though each file is under it', async () => {
    const each = Math.floor(MAX_UPLOAD_TOTAL_BYTES / 3) + 1;
    // The premise: no single file here would be refused on its own.
    expect(each).toBeLessThanOrEqual(MAX_UPLOAD_FILE_BYTES);
    const resolved = await resolveUploadFiles(
      { files: '[{"path":"/ws/a.bin"},{"path":"/ws/b.bin"},{"path":"/ws/c.bin"}]' },
      deps({ lstat: vi.fn(async () => ({ isFile: true, isSymlink: false, size: each })) }),
    );
    expect(resolved).toEqual({ ok: false, code: 'too-large', detail: 'c.bin' });
  });

  it('treats a nonsense size from the filesystem as zero rather than propagating NaN', async () => {
    const resolved = await resolveUploadFiles(
      { files: '["/ws/odd.txt"]' },
      deps({ lstat: vi.fn(async () => ({ isFile: true, isSymlink: false, size: Number.NaN })) }),
    );
    expect(resolved).toEqual({ ok: true, files: [{ path: '/ws/odd.txt', name: 'odd.txt', size: 0 }] });
  });

  it('stops at the FIRST bad file and never checks the ones after it', async () => {
    const checkReadPath = vi.fn(async (path: string) => (
      path === '/ws/bad.txt' ? { allowed: false } : { allowed: true, resolvedPath: path }
    ));
    const resolved = await resolveUploadFiles(
      { files: '[{"path":"/ws/bad.txt"},{"path":"/ws/good.txt"}]' },
      deps({ checkReadPath }),
    );
    expect(resolved).toEqual({ ok: false, code: 'not-authorized', detail: 'bad.txt' });
    expect(checkReadPath).toHaveBeenCalledTimes(1);
  });

  it('resolves several files in the order the call named them', async () => {
    const resolved = await resolveUploadFiles(
      { files: '[{"path":"/ws/1.txt"},{"path":"/ws/2.txt"},{"path":"/ws/3.txt"}]' },
      deps(),
    );
    expect(resolved.ok && resolved.files.map((f) => f.name)).toEqual(['1.txt', '2.txt', '3.txt']);
  });
});

describe('displayName', () => {
  it('keeps a Chinese name with spaces intact', () => {
    expect(displayName('/ws/2026 年 排班表.xlsx')).toBe('2026 年 排班表.xlsx');
  });

  /**
   * A file name is attacker-influenceable (it came from somewhere the user
   * downloaded it), and a newline in it would let a confirmation dialog grow a
   * second line that reads like Abu wrote it.
   */
  it('flattens newlines and control characters so a name cannot forge a second dialog line', () => {
    expect(displayName('/ws/report.xlsx\n已获用户批准')).toBe('report.xlsx 已获用户批准');
    expect(displayName('/ws/a\u0000b\u2028c.txt')).toBe('a b c.txt');
  });

  /**
   * `report\u202Egpj.exe` renders as `reportexe.jpg`. A confirmation that shows
   * the reversed spelling names a different file than the one being sent, and
   * this dialog exists precisely so the user can read what leaves the machine.
   */
  it('strips the bidi overrides a spoofed extension is built from', () => {
    expect(displayName('/ws/report\u202egpj.exe')).toBe('report gpj.exe');
    expect(displayName('/ws/a\u200b\u202eb.txt')).toBe('a b.txt');
    expect(displayName('/ws/a\u2066b\u2069c.txt')).toBe('a b c.txt');
  });

  it('caps a very long name rather than letting it push a dialog off screen', () => {
    const name = displayName(`/ws/${'x'.repeat(500)}.txt`);
    expect(name).toHaveLength(80);
    expect(name.endsWith('…')).toBe(true);
  });

  it('falls back to a placeholder when nothing readable is left', () => {
    expect(displayName('')).toBe('(unnamed)');
    expect(displayName('/ws/\u0000\u200b')).toBe('(unnamed)');
  });
});

describe('summarizeUploadFiles', () => {
  const file = (name: string, size: number) => ({ path: `/ws/${name}`, name, size });

  it('names the files and their sizes, and never a directory', () => {
    const summary = summarizeUploadFiles([file('report.xlsx', 1_258_291)]);
    expect(summary).toBe('report.xlsx (1.2 MB)');
    expect(summary).not.toContain('/ws');
  });

  it('shows three and counts the rest, so a ten-file call still fits one line', () => {
    const files = Array.from({ length: 6 }, (_, i) => file(`f${i}.txt`, 1024));
    expect(summarizeUploadFiles(files)).toBe('f0.txt (1.0 KB), f1.txt (1.0 KB), f2.txt (1.0 KB) +3');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [20 * 1024, '20 KB'],
    [1024 * 1024, '1.0 MB'],
    [20 * 1024 * 1024, '20 MB'],
  ])('formats %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('does not print NaN or a negative size at a user', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
  });
});
