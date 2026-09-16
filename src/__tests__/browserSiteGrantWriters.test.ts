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
 * The test harness's own minting helper. It lives under `src/test/` — the
 * directory `tsconfig.app.json` excludes and nothing shipped imports — and it
 * is the file that HOLDS the deliberate cast, so it matches the cast scan by
 * construction. Same relationship to the rule as `STORE`: the door, not
 * someone walking through it. Its importers are what the scan is looking for,
 * and that is checked separately below.
 */
const TEST_VERDICT_HELPER = join('src', 'test', 'browserSiteVerdicts.ts');

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
 * - `TeamConfirmationsStrip.tsx` (P1-a) — 「以后都允许该网站」 on a refused
 *   TEAM request the user is looking at. Same act as the dialog's button,
 *   in the surface a team run puts the question in: a team conversation
 *   never opens a dialog, so without this the strip could offer no scope at
 *   all and a form fill was asked field by field. It is the same decision by
 *   the same person, and it runs the same floor — `mayOfferPersistentGrant`
 *   over the requester's `allowPersistentGrant`, which the gate sets from
 *   `offersPersistentGrant` (no grant for a script, a high-risk page, an
 *   「每次询问」 row, or an unresolved origin). It grants ONLY the action's
 *   own origin and never a region's: it is not region-aware below, and the
 *   payload it reads carries no `browserPageOrigin`.
 *
 * ## The scope is the WIDE default when omitted (round-3 R3-H)
 *
 * `setBrowserSitePermission(origin, verdict, { viaEmbedPage })` takes the
 * scope as an OPTIONAL option, and leaving it out mints a full grant — one
 * that is valid on that site anywhere, in either run mode. So the dangerous
 * edit is not a new writer, it is an existing-shaped writer that learns to
 * grant on behalf of an EMBEDDED REGION and forgets the third argument:
 * nothing would be red, and a grant the user gave for one page's regions would
 * silently become a standing one. The last two cases below make that an
 * enumerated decision as well.
 */
const PERMITTED_WRITERS = [
  join('src', 'components', 'chat', 'TeamConfirmationsStrip.tsx'),
  join('src', 'components', 'common', 'CommandConfirmDialog.tsx'),
];
const SETTINGS_WRITER = join('src', 'components', 'settings', 'sections', 'NewBrowserPermissionCards.tsx');
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
    .filter((file) => file !== STORE
      && file !== TEST_VERDICT_HELPER && file !== join('src', 'test', 'migratedBrowserSettings.ts')
      && predicate(readFileSync(join(REPO_ROOT, file), 'utf-8')))
    .sort();
}

describe('browser permission writes stay in explicit user surfaces', () => {
  it('scans real sources and all approved writers', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    for (const writer of [STORE, SETTINGS_WRITER, ...PERMITTED_WRITERS]) expect(files).toContain(writer);
    expect(sep).toBeDefined();
  });
  it('allows atomic approval grants only from ordinary and team confirmation', () => {
    expect(filesMatching(src => /\.grantBrowserPermissionTargets\(/.test(src))).toEqual([...PERMITTED_WRITERS].sort());
  });
  it('allows explicit site rules only from the settings editor', () => {
    expect(filesMatching(src => /\.(setBrowserSiteRule|setBrowserEmbeddedRule)\(/.test(src))).toEqual([SETTINGS_WRITER]);
  });
  it('enumerates every remaining permission mutation API', () => {
    const writers: Record<string, string[]> = {
      setBrowserSiteResourcePermission: [],
      setBrowserPermissionDefault: [SETTINGS_WRITER],
      removeBrowserSiteRule: [SETTINGS_WRITER],
      removeBrowserEmbeddedRule: [],
      setBrowserSiteBlocked: [join('src', 'components', 'common', 'CommandConfirmDialog.tsx')],
    };
    for (const [method, expected] of Object.entries(writers)) {
      expect(filesMatching(src => src.includes(`.${method}(`)), method).toEqual(expected);
    }
    const dialog = readFileSync(join(REPO_ROOT, writers.setBrowserSiteBlocked[0]), 'utf8');
    expect(dialog.match(/\.setBrowserSiteBlocked\([^;]+/g)).toEqual([
      '.setBrowserSiteBlocked(request.browserOrigin, true)',
    ]);
  });
  it('has no active legacy site setter or raw permission-state writer', () => {
    expect(filesMatching(src => src.includes('setBrowserSitePermission('))).toEqual([]);
    expect(filesMatching(src => /setState\s*\(/.test(src) && /browserPermissionConfigV2|browserSitePermissions/.test(src))).toEqual([]);
  });
  it('passes the captured resource and full target scope from both approval writers', () => {
    for (const writer of PERMITTED_WRITERS) {
      const source = readFileSync(join(REPO_ROOT, writer), 'utf8');
      expect(source).toMatch(/\.grantBrowserPermissionTargets\([^,]*browserPermissionResource!?,[^,]*browserPermissionTargets!?, current\)/);
    }
  });
  it('never imports a permission test fixture into shipped code', () => {
    expect(filesMatching(src => /test\/(browserSiteVerdicts|migratedBrowserSettings)/.test(src))).toEqual([]);
    expect(filesMatching(src => /\bas\s+BrowserSiteVerdicts\b/.test(src))).toEqual([]);
  });
});
