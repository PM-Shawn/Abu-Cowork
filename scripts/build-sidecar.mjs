/**
 * Bundle the sidecar (sidecar/src/main.ts + the real LLM adapters it now
 * hosts, per P1-1) into a single dependency-free ESM file at
 * sidecar/index.mjs — the SAME path the Rust supervisor already spawns via
 * `resolveResource('sidecar/index.mjs')` (src/core/sidecar/sidecarManager.ts),
 * so no change is needed on that side.
 *
 * Uses esbuild (already present as a transitive dependency of vite — see
 * package-lock.json) rather than adding a new devDependency.
 *
 * Four things this build does beyond a plain esbuild bundle:
 *   1. Resolves the `@/` path alias to `src/` (the same alias every other
 *      part of the app uses), so sidecar/src files and the bundled
 *      src/core/llm/* adapters can both use `@/...` imports uniformly.
 *   2. Redirects a growing list of modules to sidecar-local shims (logging,
 *      observability/langfuse, Tauri fetch, i18n, enterprise LLM creds,
 *      selectChatAdapter, lifecycleHooks, memdir/scan — see SHIM_TARGETS)
 *      because those modules' REAL implementations reach into
 *      Tauri/webview-only APIs (`@tauri-apps/plugin-fs`,
 *      `@tauri-apps/plugin-http`, `@tauri-apps/api/path`, `window`, React's
 *      `useSyncExternalStore`) or webview-singleton state that don't
 *      exist/aren't meaningful in a plain Node process. The match is done
 *      on the RESOLVED ABSOLUTE PATH of the import, not the import
 *      specifier string — a file can be reached via a relative import
 *      (`../logging/logger`) from one caller and via the `@/` alias
 *      (`@/core/logging/logger`) from another, and both must redirect to
 *      the same shim.
 *   3. Bundles `@anthropic-ai/sdk` into the output rather than marking it
 *      external — the packaged app ships no node_modules alongside
 *      sidecar/index.mjs, so anything not bundled would be unresolvable at
 *      runtime.
 *   4. Fails the build (rather than silently producing a broken bundle) if
 *      the resolved import graph ever reaches `src/stores/**`,
 *      `src/components/**`, or a bare `@tauri-apps/*` package that isn't
 *      already redirected by a shim above — see `bundleGraphGuardPlugin`
 *      below (P1-3a, design doc §2 item 9). This is both a safety net and
 *      the debugging tool for the bundle graph: a failure prints the
 *      offending resolved path and its direct importer.
 *
 * Run via: npm run build:sidecar
 */

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcDir = path.resolve(root, 'src');

/**
 * Shim map: resolved absolute path of the REAL module -> resolved absolute
 * path of its sidecar-local replacement. Extensionless — esbuild's own
 * resolver appends `.ts` when it resolves the real import, so we resolve
 * both sides through the same `build.resolve()` call in the plugin below
 * rather than hardcoding an extension here (keeps this map source-of-truth
 * agnostic to whether the real files are `.ts` or `.tsx`).
 */
const SHIM_TARGETS = [
  { real: path.resolve(srcDir, 'core/logging/logger.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/logger.ts') },
  { real: path.resolve(srcDir, 'core/observability/compatEvents.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/compatEvents.ts') },
  { real: path.resolve(srcDir, 'core/llm/tauriFetch.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/tauriFetch.ts') },
  // P1-3a additions (docs/2026-07-19-phase1-p3-loop-migration-staging.md §2
  // "正式步 3a" item 8) — subagentLoop.ts's remaining shell-singleton /
  // store-coupled bare imports, each redirected to a sidecar-local
  // replacement. See each shim file's own module doc for why it exists and
  // what behavior it preserves/documents-as-different.
  { real: path.resolve(srcDir, 'i18n/index.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/i18nRun.ts') },
  { real: path.resolve(srcDir, 'core/enterprise/llm-resolver.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/enterpriseCredsRun.ts') },
  { real: path.resolve(srcDir, 'core/llm/selectChatAdapter.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/selectChatAdapterRun.ts') },
  { real: path.resolve(srcDir, 'core/agent/lifecycleHooks.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/lifecycleHooksRun.ts') },
  { real: path.resolve(srcDir, 'core/observability/langfuse.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/langfuseRun.ts') },
  // memdir/paths.ts is NOT separately shimmed — nothing in subagentLoop.ts's
  // dependency graph imports it directly once memdir/scan.ts (below) is
  // redirected; memdirScan.ts imports its own sibling `./memdirPaths` helper
  // instead of the real `memdir/paths.ts`, so the real file is simply never
  // reached. See memdirPaths.ts's module doc.
  { real: path.resolve(srcDir, 'core/memdir/scan.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/memdirScan.ts') },
  // Port bundle-graph shims (found via the fail-fast guard below, NOT
  // anticipated in the original inventory): subagentLoop.ts's
  // `options?.x ?? getX()` fallback pattern means the REAL port's default
  // in-process factory is statically bundled even on a branch that's
  // provably dead at sidecar runtime (subagentHost.ts always injects all
  // four). Each shim throws if its fallback is ever actually reached — see
  // each shim file's own doc.
  { real: path.resolve(srcDir, 'core/agent/ports/settingsReader.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/settingsReaderRun.ts') },
  { real: path.resolve(srcDir, 'core/agent/ports/toolInvoker.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/toolInvokerRun.ts') },
  { real: path.resolve(srcDir, 'core/agent/ports/capsPort.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/capsPortRun.ts') },
  { real: path.resolve(srcDir, 'core/agent/ports/workspaceReader.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/workspaceReaderRun.ts') },
];

for (const { real, shim } of SHIM_TARGETS) {
  if (!existsSync(real)) throw new Error(`[build-sidecar] shim target source moved or renamed: ${real}`);
  if (!existsSync(shim)) throw new Error(`[build-sidecar] missing shim file: ${shim}`);
}

const shimMap = new Map(SHIM_TARGETS.map(({ real, shim }) => [real, shim]));

/**
 * Redirects the 3 shimmed modules to their sidecar-local replacement,
 * matching on the fully-RESOLVED absolute path rather than the import
 * specifier string (a relative import and a `@/`-aliased import can both
 * reach the same file). Narrowly filtered (by a keyword substring of the
 * specifier) purely to avoid re-resolving every single import in the bundle
 * — the actual redirect decision below still only fires on an exact
 * resolved-path match against `shimMap`, so a false-positive filter match
 * (e.g. an unrelated file that happens to contain "logger" in its path)
 * would just pass through unchanged, never get mis-redirected.
 */
const shimPlugin = {
  name: 'abu-sidecar-shims',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /logger|compatEvents|tauriFetch|i18n|llm-resolver|selectChatAdapter|lifecycleHooks|langfuse|memdir|settingsReader|toolInvoker|capsPort|workspaceReader/i }, async (args) => {
      // Recursion guard: this handler calls build.resolve() below to find out
      // where the specifier ACTUALLY lands, which re-enters esbuild's
      // resolution pipeline (and this same onResolve callback, since the
      // filter still matches the same specifier). Bail out to default
      // resolution on the re-entrant call instead of looping forever.
      if (args.pluginData?.abuShimResolving) return null;

      const resolved = await pluginBuild.resolve(args.path, {
        resolveDir: args.resolveDir,
        kind: args.kind,
        importer: args.importer,
        pluginData: { abuShimResolving: true },
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };

      const shimPath = shimMap.get(resolved.path);
      if (shimPath) return { path: shimPath };
      return null; // no match — let esbuild's default resolution proceed normally
    });
  },
};

/**
 * Fail-fast bundle-graph guard (P1-3a, design doc §2 item 9 / §4 risk
 * table's "打包图谱仍拖进 webview 簇" mitigation): FAILS the build — instead
 * of silently succeeding with a broken/webview-coupled bundle — if the
 * resolved import graph reaching `sidecar/src/main.ts` ever contains:
 *   - a bare `@tauri-apps/*` package import (checked on the SPECIFIER —
 *     package imports resolve via node_modules, not our alias/relative
 *     logic, so no resolve round-trip is needed to check this precisely);
 *   - any module physically under `src/stores/**` or `src/components/**`
 *     (checked on the FINAL RESOLVED absolute path, via `onLoad` — so this
 *     naturally never fires for a module that `shimPlugin` already
 *     redirected away, since the real file is never loaded in that case:
 *     "except the shimmed ones" per the design doc, satisfied by ordering,
 *     not a separate allowlist).
 * Registered AFTER `shimPlugin` so already-shimmed modules get redirected
 * first; this is a backstop for anything NOT yet shimmed, and doubles as
 * the debugging tool for the bundle graph the design doc calls for — a
 * failure here prints the offending resolved path + its direct importer.
 */
const FORBIDDEN_DIR_PREFIXES = [
  path.resolve(srcDir, 'stores') + path.sep,
  path.resolve(srcDir, 'components') + path.sep,
];

const bundleGraphGuardPlugin = {
  name: 'abu-sidecar-fail-fast-guard',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@tauri-apps\// }, (args) => {
      return {
        errors: [{
          text: `[build-sidecar] Forbidden import: "${args.path}" (a @tauri-apps/* package) imported from "${args.importer}". The sidecar bundle must never import Tauri APIs directly — add a SHIM_TARGETS redirect for the importing module, or fix it to not need Tauri.`,
        }],
      };
    });

    pluginBuild.onLoad({ filter: /\.tsx?$/ }, (args) => {
      const isForbidden = FORBIDDEN_DIR_PREFIXES.some((prefix) => args.path.startsWith(prefix));
      if (isForbidden) {
        return {
          errors: [{
            text: `[build-sidecar] Forbidden module resolved into the sidecar bundle: "${args.path}". src/stores/** and src/components/** must never be reachable from sidecar/src/main.ts — add a SHIM_TARGETS redirect (or a pure-module extraction, see settingsSelectors.ts) upstream of whatever imported this.`,
          }],
        };
      }
      return null; // let esbuild's default loading proceed normally
    });
  },
};

async function main() {
  await build({
    entryPoints: [path.resolve(__dirname, '../sidecar/src/main.ts')],
    outfile: path.resolve(__dirname, '../sidecar/index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: false,
    minify: false,
    // @anthropic-ai/sdk (and everything else reachable from main.ts) bundles
    // INTO the output — nothing marked external. The packaged app ships
    // sidecar/index.mjs standalone, with no node_modules alongside it.
    alias: { '@': srcDir },
    plugins: [shimPlugin, bundleGraphGuardPlugin],
    banner: {
      // Bundled ESM output has no CommonJS __dirname/__filename or `require`
      // — nothing in this bundle currently needs them (no other bundled
      // dependency probes for them either), but shim them defensively so a
      // future dependency that does something like `require.resolve(...)` or
      // reads `__dirname` for asset lookup doesn't silently break at runtime
      // instead of at this build step.
      js:
        "import { createRequire as __abuCreateRequire } from 'node:module';\n" +
        "import { fileURLToPath as __abuFileURLToPath } from 'node:url';\n" +
        "import { dirname as __abuDirname } from 'node:path';\n" +
        'const require = __abuCreateRequire(import.meta.url);\n' +
        'const __filename = __abuFileURLToPath(import.meta.url);\n' +
        'const __dirname = __abuDirname(__filename);\n',
    },
  });
  console.log('[build-sidecar] sidecar/index.mjs built');
}

main().catch((err) => {
  console.error('[build-sidecar] build failed:', err);
  process.exit(1);
});
