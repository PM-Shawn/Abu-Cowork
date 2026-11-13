import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { SCIENTIFIC_TEST_DIRS, findSitePackages, stripScientificTests } from './pythonRuntimeStrip.mjs';

const roots: string[] = [];
function runtime(layout: 'windows' | 'unix'): { root: string; site: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'xs-pyrt-'));
  roots.push(root);
  const site = layout === 'windows' ? path.join(root, 'Lib', 'site-packages') : path.join(root, 'lib', 'python3.12', 'site-packages');
  for (const dir of [...SCIENTIFIC_TEST_DIRS, 'pandas/core', 'matplotlib/mpl-data/fonts', 'numpy/_core']) {
    mkdirSync(path.join(site, dir), { recursive: true });
    writeFileSync(path.join(site, dir, 'x.py'), '');
  }
  return { root, site };
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('bundled Python runtime stripping', () => {
  it.each(['windows', 'unix'] as const)('removes the test suites on the %s layout and keeps the libraries', (layout) => {
    const { root, site } = runtime(layout);
    expect(findSitePackages(root)).toBe(site);
    expect(stripScientificTests(root)).toBe(SCIENTIFIC_TEST_DIRS.length);
    for (const dir of SCIENTIFIC_TEST_DIRS) expect(existsSync(path.join(site, dir))).toBe(false);
    for (const keep of ['pandas/core', 'matplotlib/mpl-data/fonts', 'numpy/_core']) expect(existsSync(path.join(site, keep))).toBe(true);
  });

  it('is harmless on a runtime without those folders', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'xs-pyrt-'));
    roots.push(root);
    expect(stripScientificTests(root)).toBe(0);
  });
});
