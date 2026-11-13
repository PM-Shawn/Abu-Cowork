/**
 * One list of credential locations, three readers.
 *
 * `src/core/tools/sensitivePaths.json` feeds the tool path checks
 * (pathSafety.ts), the macOS sandbox's read-deny list (commandHost.cjs) and
 * the preview server's blocked names (previewServer.cjs). These cases fail the
 * day one reader goes back to a list of its own.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import lists from '../src/core/tools/sensitivePaths.json';

const require_ = createRequire(import.meta.url);
const { SENSITIVE_READ_PATHS } = require_('./commandHost.cjs') as { SENSITIVE_READ_PATHS: string[] };
const { isBlocked } = require_('./previewServer.cjs') as { isBlocked: (target: string, root: string) => boolean };

describe('sensitive path list', () => {
  it('closes every credential location in the macOS sandbox, not a subset', () => {
    const missing = [...lists.credentials.all, ...lists.credentials.mac].filter((p) => !SENSITIVE_READ_PATHS.includes(p));
    expect(missing).toEqual([]);
  });

  it('keeps the sandbox free of files that ordinary commands read (.gitconfig, shell rc files)', () => {
    const startup = [...lists.startupConfigs.all, ...lists.startupConfigs.mac];
    expect(SENSITIVE_READ_PATHS.filter((p) => startup.includes(p))).toEqual([]);
  });

  it('blocks every single-name credential entry as a preview path segment', () => {
    const root = path.join('/srv', 'site');
    const names = lists.credentials.all.filter((p) => !p.includes('/'));
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(isBlocked(path.join(root, name, 'x'), root), name).toBe(true);
  });

  it('still serves ordinary files', () => {
    expect(isBlocked('/srv/site/index.html', '/srv/site')).toBe(false);
  });
});
