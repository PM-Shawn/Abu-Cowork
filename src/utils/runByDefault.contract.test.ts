// @vitest-environment node
/**
 * The main process decides which files it refuses to open (electron/openPathPolicy.cjs);
 * the interface reads its own copy of the list to offer the file manager for them, and
 * recognizes the refusal by its message. The two sides cannot import each other.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPEN_REFUSED_RUNS_BY_DEFAULT } from './openWithDefaultApp';
import { RUN_BY_DEFAULT_EXTENSIONS, isRunByDefault } from './runByDefault';

const require_ = createRequire(import.meta.url);
const electronDir = fileURLToPath(new URL('../../electron/', import.meta.url));
const main = require_(join(electronDir, 'openPathPolicy.cjs')) as {
  OPEN_REFUSED_RUNS_BY_DEFAULT: string;
  RUN_BY_DEFAULT_EXTENSIONS: Set<string>;
  resolveOpenTarget: (
    path: string,
    deps: { platform: string; fs: { realpath: (p: string) => Promise<string>; stat: (p: string) => Promise<{ isFile: () => boolean; mode: number }> } },
  ) => Promise<{ path: string } | { refused: string }>;
};

describe('run-by-default contract between the interface and the main process', () => {
  it('both sides hold the same extensions', () => {
    expect([...RUN_BY_DEFAULT_EXTENSIONS].sort()).toEqual([...main.RUN_BY_DEFAULT_EXTENSIONS].sort());
  });

  it('both sides name the refusal the same way', () => {
    expect(OPEN_REFUSED_RUNS_BY_DEFAULT).toBe(main.OPEN_REFUSED_RUNS_BY_DEFAULT);
  });

  it('the main process refuses every extension the interface hides the open action for', async () => {
    const fs = { realpath: async (p: string) => p, stat: async () => ({ isFile: () => true, mode: 0o644 }) };
    for (const extension of RUN_BY_DEFAULT_EXTENSIONS) {
      for (const [platform, path] of [['darwin', `/w/sample.${extension}`], ['win32', `C:\\w\\sample.${extension}`]] as const) {
        expect(isRunByDefault(path)).toBe(true);
        expect(await main.resolveOpenTarget(path, { platform, fs })).toEqual({ refused: main.OPEN_REFUSED_RUNS_BY_DEFAULT });
      }
    }
  });
});
