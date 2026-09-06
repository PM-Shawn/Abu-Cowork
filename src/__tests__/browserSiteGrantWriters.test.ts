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
 * Four ways in are checked:
 *  1. the store's setter, `setBrowserSitePermission`;
 *  2. writing the `browserSitePermissions` map straight through `setState`,
 *     which would bypass the setter entirely;
 *  3. casting to the branded `BrowserSiteVerdicts` type, which is how a
 *     writer would get past the compiler now that the field is nominal
 *     (config-batch4);
 *  4. importing the test-only minting helper from shipped code.
 *
 * (3) and (4) are the escape hatches the TYPE constraint leaves open. The
 * brand makes an accidental writer impossible — `setState({
 * browserSitePermissions: {...} })` no longer compiles anywhere outside
 * `settingsStore.ts` — but any nominal type in TypeScript can be forced with
 * an `as`, so the scan still has to say that forcing it is a decision rather
 * than a detail.
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
 *
 * ## The mark is the WIDE default when omitted (round-3 R3-H)
 *
 * `setBrowserSitePermission(origin, verdict, { viaEmbed })` takes the mark as
 * an OPTIONAL option, and leaving it out mints a full grant — the kind an
 * automatic task may act on. So the dangerous edit is not a new writer, it is
 * an existing-shaped writer that learns to grant on behalf of an EMBEDDED
 * REGION and forgets the third argument: nothing would be red, and a region
 * grant would silently become a standing one. The last two cases below make
 * that an enumerated decision as well.
 */
const PERMITTED_WRITERS = [
  join('src', 'components', 'common', 'CommandConfirmDialog.tsx'),
  join('src', 'components', 'settings', 'sections', 'BrowserPermissionCards.tsx'),
];

/**
 * The writers that grant on behalf of an EMBEDDED REGION, and therefore have
 * to mark what they mint. Exactly one today: the merged prompt, which is the
 * only surface that is ever shown a page's embedded origins.
 *
 * `browserPageOrigin` is the signal — the gate sends it only when the action
 * lands somewhere other than the top page, so a writer that reads it is by
 * definition deciding about a region.
 */
const REGION_AWARE_WRITERS = [
  join('src', 'components', 'common', 'CommandConfirmDialog.tsx'),
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
    .filter((file) => file !== STORE
      && file !== TEST_VERDICT_HELPER
      && predicate(readFileSync(join(REPO_ROOT, file), 'utf-8')))
    .sort();
}

describe('standing browser site verdicts have exactly two writers', () => {
  it('finds the files it is asserting about (the scan is not silently empty)', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(STORE);
    expect(files).toContain(TEST_VERDICT_HELPER);
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

  it('lets nobody force the brand with a cast', () => {
    // The compile-time half of the rule (config-batch4): the field's type is
    // nominal, so only `settingsStore.ts`'s module-private
    // `mintBrowserSiteVerdicts` can produce one. A cast is the one way past
    // that, and it must not appear in shipped code.
    const forced = filesMatching((src) => /\bas\s+BrowserSiteVerdicts\b/.test(src));
    expect(forced).toEqual([]);
  });

  it('lets nobody but the merged region prompt mint a MARKED grant', () => {
    // The mark itself is a small enumerable set, so that "which screens can
    // produce a grant an automatic task may NOT act on" stays answerable by
    // reading one list.
    const markers = filesMatching((src) => /viaEmbed:\s*true/.test(src));
    expect(markers).toEqual([...REGION_AWARE_WRITERS].sort());
  });

  it('makes a writer that knows about embedded regions mark what it mints', () => {
    // The failure this catches: a NEW granting surface (or a change to an
    // existing one) that starts reading `browserPageOrigin` — i.e. starts
    // deciding about a region — and calls the setter without the mark. The
    // option is optional and omitting it is the WIDE branch, so nothing else
    // in the build would notice.
    const grantsForRegionsUnmarked = filesMatching(
      (src) => src.includes('setBrowserSitePermission(')
        && src.includes('browserPageOrigin')
        && !src.includes('viaEmbed'),
    );
    expect(grantsForRegionsUnmarked).toEqual([]);

    // …and the region-aware writer really is one, so the case above is not
    // passing on an empty premise.
    const regionAware = filesMatching(
      (src) => src.includes('setBrowserSitePermission(') && src.includes('browserPageOrigin'),
    );
    expect(regionAware).toEqual([...REGION_AWARE_WRITERS].sort());
  });

  it('lets nobody reach for the test-only minting helper', () => {
    // `src/test/browserSiteVerdicts.ts` casts on purpose, for component tests
    // that arrange standing verdicts without driving the UI. A shipped file
    // importing it would be that same cast wearing a helper's name.
    const importers = filesMatching((src) => src.includes('test/browserSiteVerdicts'));
    expect(importers).toEqual([]);
  });
});
