/**
 * Who may mint a standing browser site verdict.
 *
 * `'allowed'` is the strongest thing this app stores about a website: it is
 * what stops the confirmation dialog appearing, AND it is the one signal that
 * lets an AUTOMATIC task act on that site at all (`decideBrowserOperation`
 * refuses an unattended call on anything without it). Its safety argument is
 * provenance, not shape: every one of them is a human act, taken in a surface
 * the user opened, with the reason next to the control.
 *
 * That argument only holds while the writers can be enumerated. This test
 * enumerates them. Adding a third file to the list is not forbidden — it is
 * required to be a DECISION, taken by whoever adds it, rather than something
 * that shows up in a diff nobody reads.
 *
 * Two ways in are checked:
 *  1. the store's setter, `setBrowserSitePermission`;
 *  2. writing the `browserSitePermissions` map straight through `setState`,
 *     which would bypass the setter entirely.
 *
 * Deliberately a source scan rather than a runtime spy: the property is about
 * code that EXISTS, and a call site nobody exercises in a test would be
 * invisible to a spy while being just as real at runtime.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_ROOTS = ['src', 'electron'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'coverage', '__mocks__']);

/**
 * The store module itself: it DECLARES the setter and the state field, so it
 * matches every pattern below by construction. It is the door, not someone
 * walking through it.
 */
const STORE = join('src', 'stores', 'settingsStore.ts');

/**
 * Every file that may write a site verdict, and the user action behind each.
 *
 * - `CommandConfirmDialog.tsx` — "always allow this site" / "block this site"
 *   on a confirmation the user is looking at (writes both verdicts).
 * - `BrowserPermissionCards.tsx` — Settings › 网站授权: the per-row verdict
 *   select, and (F1, 2026-09-04) the add row. Both are the user typing or
 *   clicking in a settings page they navigated to; the add row additionally
 *   refuses to mint `'allowed'` for a high-risk origin, which the dialog also
 *   refuses (`allowPersistentGrant: false`).
 */
const PERMITTED_WRITERS = [
  join('src', 'components', 'common', 'CommandConfirmDialog.tsx'),
  join('src', 'components', 'settings', 'sections', 'BrowserPermissionCards.tsx'),
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      // Tests may say anything about the store; they are not shipped behavior.
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      out.push(relative(REPO_ROOT, full));
    }
  };
  for (const root of SCAN_ROOTS) {
    const full = join(REPO_ROOT, root);
    if (existsSync(full)) walk(full);
  }
  return out;
}

function filesMatching(predicate: (source: string) => boolean): string[] {
  return sourceFiles()
    .filter((file) => file !== STORE && predicate(readFileSync(join(REPO_ROOT, file), 'utf-8')))
    .sort();
}

describe('standing browser site verdicts have exactly two writers', () => {
  it('finds the files it is asserting about (the scan is not silently empty)', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(STORE);
    for (const writer of PERMITTED_WRITERS) expect(files).toContain(writer);
    // A path typo in PERMITTED_WRITERS would otherwise make this suite pass by
    // comparing two empty-ish sets.
    expect(sep).toBeDefined();
  });

  it('lets nobody else call the setter', () => {
    expect(filesMatching((src) => src.includes('setBrowserSitePermission(')))
      .toEqual([...PERMITTED_WRITERS].sort());
  });

  it('lets nobody write the verdict map around the setter', () => {
    // `setState({ browserSitePermissions: ... })` would be a grant with none
    // of the setter's call sites — invisible to the test above.
    const bypass = filesMatching(
      (src) => /setState\s*\(/.test(src) && src.includes('browserSitePermissions'),
    );
    expect(bypass).toEqual([]);
  });
});
