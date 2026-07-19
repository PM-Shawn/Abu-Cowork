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
 * Three things this build does beyond a plain esbuild bundle:
 *   1. Resolves the `@/` path alias to `src/` (the same alias every other
 *      part of the app uses), so sidecar/src files and the bundled
 *      src/core/llm/* adapters can both use `@/...` imports uniformly.
 *   2. Redirects three specific modules to sidecar-local shims — logging,
 *      observability, and the Tauri fetch wrapper — because those modules'
 *      REAL implementations reach into Tauri/webview-only APIs
 *      (`@tauri-apps/plugin-fs`, `@tauri-apps/plugin-http`, `window`) that
 *      don't exist in a plain Node process. The match is done on the
 *      RESOLVED ABSOLUTE PATH of the import, not the import specifier
 *      string — a file can be reached via a relative import
 *      (`../logging/logger`) from one caller and via the `@/` alias
 *      (`@/core/logging/logger`) from another, and both must redirect to
 *      the same shim.
 *   3. Bundles `@anthropic-ai/sdk` into the output rather than marking it
 *      external — the packaged app ships no node_modules alongside
 *      sidecar/index.mjs, so anything not bundled would be unresolvable at
 *      runtime.
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
    pluginBuild.onResolve({ filter: /logger|compatEvents|tauriFetch/i }, async (args) => {
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
    plugins: [shimPlugin],
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
