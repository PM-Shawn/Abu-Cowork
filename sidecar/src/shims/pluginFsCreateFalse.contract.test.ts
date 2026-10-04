// @vitest-environment node

/**
 * Contract test: `create: false` means the same thing in both shims of
 * `@tauri-apps/plugin-fs` — `electron/fsHost.cjs` (renderer calls) and
 * `pluginFsRun.ts` (sidecar-resident code). It runs on the Windows job, where
 * open(2) flag handling differs the most: `electron/fsHost.security.test.cjs`
 * is a `node:test` file and does not run there, so this is the first coverage
 * of the main process's own open on Windows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { chmod, mkdtemp, readFile, rm, writeFile as nodeWriteFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTextFile } from './pluginFsRun';

const require_ = createRequire(import.meta.url);
const { fsDispatch } = require_('../../../electron/fsHost.cjs') as {
  fsDispatch: (app: unknown, cmd: string, payload: { headers: Record<string, string>; body: Uint8Array }) => unknown;
};

type Options = { create?: boolean; append?: boolean };
const tiers: { name: string; write: (path: string, text: string, options: Options) => Promise<void> }[] = [
  {
    name: 'electron/fsHost.cjs',
    write: async (path, text, options) => {
      fsDispatch({}, 'plugin:fs|write_text_file', {
        headers: { path: encodeURIComponent(path), options: JSON.stringify(options) },
        body: new TextEncoder().encode(text),
      });
    },
  },
  { name: 'sidecar pluginFsRun', write: (path, text, options) => writeTextFile(path, text, options) },
];

describe.each(tiers)('create:false — $name', ({ write }) => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'abu-create-false-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('refuses a missing file and creates nothing', async () => {
    const path = join(dir, 'missing.md');
    await expect(write(path, 'x', { create: false })).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to append to a missing file and creates nothing', async () => {
    const path = join(dir, 'missing.log');
    await expect(write(path, 'x', { create: false, append: true })).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('replaces the content of an existing file, shorter content included', async () => {
    const path = join(dir, 'a.md');
    await nodeWriteFile(path, 'a much longer old content');
    await write(path, 'short', { create: false });
    expect(await readFile(path, 'utf-8')).toBe('short');
  });

  it('appends to an existing file without truncating it', async () => {
    const path = join(dir, 'a.log');
    await nodeWriteFile(path, 'first\n');
    await write(path, 'second\n', { create: false, append: true });
    await write(path, 'third\n', { create: false, append: true });
    expect(await readFile(path, 'utf-8')).toBe('first\nsecond\nthird\n');
  });

  it.skipIf(process.platform === 'win32')('writes a file whose owner left it write-only', async () => {
    const path = join(dir, 'wo.md');
    await nodeWriteFile(path, 'old');
    await chmod(path, 0o200);
    await write(path, 'new', { create: false });
    await chmod(path, 0o600);
    expect(await readFile(path, 'utf-8')).toBe('new');
  });
});
