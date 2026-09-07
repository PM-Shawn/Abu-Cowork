import type { BrowserSiteVerdicts } from '@/core/permissions/browserToolPolicy';

/**
 * Build a `browserSitePermissions` value for a TEST.
 *
 * `BrowserSiteVerdicts` is branded so that only `settingsStore`'s own setters
 * can mint one (see `BROWSER_SITE_VERDICTS_BRAND`). Tests need to arrange
 * arbitrary standing verdicts without going through the UI that writes them,
 * which has always been true — `browserSiteGrantWriters.test.ts` skips test
 * files for exactly that reason: "tests may say anything about the store; they
 * are not shipped behavior".
 *
 * This helper exists so that permission is spelled ONCE, in a file named after
 * what it does, instead of as a dozen anonymous `as never` casts scattered
 * through component tests where nobody would notice a production file picking
 * up the same trick. `browserSiteGrantWriters.test.ts` asserts that no shipped
 * source file imports it, and that none of them casts to the branded type by
 * hand either.
 *
 * Do not import this from anything under `src/` that ships.
 */
export function testSiteVerdicts(
  entries: Record<string, 'allowed' | 'denied'> = {},
): BrowserSiteVerdicts {
  return entries as BrowserSiteVerdicts;
}
