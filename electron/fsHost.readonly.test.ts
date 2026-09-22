// @vitest-environment node

/**
 * `FileInfo.readonly` for the Electron `plugin:fs` host.
 *
 * plugin-fs derives this field from Rust's `std::fs::Permissions::readonly()`:
 * on Unix that is `mode & 0o222 == 0` (ANY write bit), on Windows it is the
 * `FILE_ATTRIBUTE_READONLY` attribute. Abu has three shims of that one
 * contract — this host, `sidecar/src/shims/pluginFsRun.ts` and
 * `sidecar/src/fsHost.ts` — and they must not disagree.
 *
 * These cases run on `test-windows` as well as locally (vitest picks up
 * `electron/**\/*.test.ts`), which is the point: `node:fs`'s `mode` on Windows
 * is synthesized by libuv from the readonly attribute, so the SAME `& 0o222`
 * expression should hold on both platforms. This host used to special-case
 * Windows to a hardcoded `false`, i.e. "no file is ever readonly"; CI on a real
 * Windows runner is what decides whether the shared expression is right, not a
 * guess made on macOS.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toFileInfo } from './fsHost.cjs';

const isWindows = process.platform === 'win32';

describe('fsHost toFileInfo readonly', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-fshost-ro-'));
  });

  afterEach(() => {
    // Restore write permission first: a still-readonly file cannot be removed
    // on Windows.
    for (const name of fs.readdirSync(dir)) {
      try { fs.chmodSync(path.join(dir, name), 0o644); } catch { /* already gone */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readonlyOf(mode: number): boolean {
    const file = path.join(dir, `mode-${mode.toString(8)}.txt`);
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, mode);
    return toFileInfo(fs.statSync(file)).readonly;
  }

  it('reports a file nobody can write as readonly', () => {
    expect(readonlyOf(0o444)).toBe(true);
  });

  it('reports a writable file as not readonly', () => {
    expect(readonlyOf(0o644)).toBe(false);
  });

  // The modes that split an owner-only mask from the plugin's: Windows has no
  // group/other bits to set, so these are Unix-only.
  it.skipIf(isWindows)('reports a group-writable file as not readonly', () => {
    expect(readonlyOf(0o464)).toBe(false);
  });

  it.skipIf(isWindows)('reports an other-writable file as not readonly', () => {
    expect(readonlyOf(0o446)).toBe(false);
  });
});

describe('file identity survives the Electron wire format on every platform', () => {
  it('preserves native device and inode, so Windows approval can detect replacement', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-identity-'));
    try {
      const target = path.join(dir, 'approved.txt');
      const replacement = path.join(dir, 'replacement.txt');
      fs.writeFileSync(target, 'approved'); fs.writeFileSync(replacement, 'replaced');
      const before = fs.statSync(target);
      const mapped = toFileInfo(before);
      expect(mapped.dev).toBe(before.dev);
      expect(mapped.ino).toBe(before.ino);
      fs.renameSync(target, path.join(dir, 'original.txt'));
      fs.renameSync(replacement, target);
      const after = toFileInfo(fs.statSync(target));
      expect(after.ino).not.toBe(mapped.ino);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  /**
   * An NTFS file id packs a record sequence number above the record index, so a
   * volume that has been in use for a while reports ids past 2^53. The case
   * above carries whatever id the runner's own volume hands out, which on APFS
   * or ext4 is a small number; this one states the width the wire has to carry,
   * because an id that reaches the renderer as `null` leaves upload approval
   * comparing nothing but a size and a timestamp.
   */
  it('carries a file id wider than 2^53, which is the width NTFS reports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-identity-wide-'));
    try {
      const target = path.join(dir, 'approved.txt');
      fs.writeFileSync(target, 'approved');
      const wide = fs.statSync(target);
      wide.ino = 9288674232255540;
      expect(Number.isSafeInteger(wide.ino)).toBe(false);
      expect(toFileInfo(wide).ino).toBe(wide.ino);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
