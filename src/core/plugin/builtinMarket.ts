/**
 * The Abu official marketplace that ships inside the app.
 *
 * Preloaded so a fresh install already has a market to browse — the user's
 * decision was to preload the *source* (this one, ours), never to preinstall
 * any plugin, and never to preload a third-party market. It mirrors the
 * `builtin-skills` bundling exactly: `resolveResource` in a packaged build, a
 * relative-path fallback in dev where `resolveResource` has nothing to resolve.
 *
 * The directory holds the same `.abu-plugin/marketplace.json` + vendored
 * (`relative`-source) plugins any user-authored market would, so it flows
 * through the ordinary parse/install path with no special-casing downstream.
 */

import { resolve, resolveResource } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';

/** Stable name of the built-in market. Also its identity in the market list. */
export const BUILTIN_MARKET_NAME = 'abu-official';

/** Resource directory name, bundled via electron-builder `extraResources`. */
const BUILTIN_MARKET_DIRNAME = 'builtin-plugin-market';

/**
 * Absolute path to the bundled market directory, or `null` when it cannot be
 * located (which must degrade to "no built-in market", never throw — a missing
 * bundle should not take the plugins page down).
 *
 * Injectable resolvers keep this unit-testable without a real app bundle.
 */
export async function resolveBuiltinMarketDir(
  deps: {
    resolveResource?: (name: string) => Promise<string>;
    resolve?: (path: string) => Promise<string>;
    exists?: (path: string) => Promise<boolean>;
  } = {},
): Promise<string | null> {
  const resolveResourceFn = deps.resolveResource ?? resolveResource;
  const resolveFn = deps.resolve ?? resolve;
  const existsFn = deps.exists ?? exists;

  // Packaged build: the bundle's resource dir.
  try {
    const resourceDir = await resolveResourceFn(BUILTIN_MARKET_DIRNAME);
    if (resourceDir && (await existsFn(resourceDir))) return resourceDir;
  } catch {
    // resolveResource has nothing to resolve in dev — fall through.
  }

  // Dev fallback: the repo checkout. CWD can be the repo root or src-tauri/.
  for (const candidate of [`../${BUILTIN_MARKET_DIRNAME}`, BUILTIN_MARKET_DIRNAME]) {
    try {
      const devDir = await resolveFn(candidate);
      if (await existsFn(devDir)) return devDir;
    } catch {
      // try next
    }
  }

  return null;
}
