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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcDir = path.resolve(root, 'src');

/**
 * `vite.config.ts` substitutes `__APP_VERSION__`/`__ENTERPRISE_BUILD__` as
 * build-time `define`s for the webview bundle — esbuild's sidecar bundle
 * doesn't share that config, so without an equivalent `define` here these
 * two globals are left as bare undefined references, which THROW at sidecar
 * process startup (found via the standalone `node sidecar/index.mjs`
 * protocol sanity check, P1-3B-3A item 7 — `src/utils/version.ts`, now
 * reachable via `agentLoop.ts`'s `consoleError.ts`/`reportError` chain,
 * reads `__APP_VERSION__` at module top level). `__ENTERPRISE_BUILD__` is
 * reachable via `src/config/featureGates.ts` — defined defensively even if
 * not currently on a live sidecar-reachable path, since a false `undefined`
 * reference would be the same class of startup crash.
 */
const packageJson = JSON.parse(readFileSync(path.resolve(root, 'package.json'), 'utf-8'));

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
  { real: path.resolve(srcDir, 'core/enterprise/entitlement.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/enterpriseEntitlementRun.ts') },
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
  // P1-3B-3A additions (docs/2026-07-20-phase1-p3b-loop-entry-design.md —
  // moving the MAIN agent loop, runAgentLoop, into the sidecar). New
  // ALS-backed REAL port shims (agentLoop.ts reads these 5 via bare module
  // getters with no AgentLoopOptions injection field, unlike the 4 above —
  // see agentRunContext.ts's module doc + P1-3B-3A-REPORT.md's inventory):
  { real: path.resolve(srcDir, 'core/agent/ports/chatDelta.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/chatDeltaRun.ts') },
  { real: path.resolve(srcDir, 'core/agent/ports/conversationReader.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/conversationReaderRun.ts') },
  { real: path.resolve(srcDir, 'core/agent/ports/executionPort.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/executionPortRun.ts') },
  { real: path.resolve(srcDir, 'core/agent/ports/abortRegistry.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/abortRegistryRun.ts') },
  { real: path.resolve(srcDir, 'core/agent/ports/scratchpadPort.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/scratchpadPortRun.ts') },
  // Throwing bundle-graph-only shims — orchestrator.ts/entryOrchestration.ts
  // only ever run shell-side; agentLoop.ts's dynamic-import fallback branch
  // is provably dead once agentLoopHost.ts always injects
  // options.orchestration (see entryOrchestration.ts's + these shims' doc
  // comments for the full "雷 1" reasoning).
  { real: path.resolve(srcDir, 'core/agent/orchestrator.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/orchestratorRun.ts') },
  { real: path.resolve(srcDir, 'core/agent/entryOrchestration.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/entryOrchestrationRun.ts') },
  // Real shim — node:os.platform() mapping, see platformRun.ts.
  { real: path.resolve(srcDir, 'utils/platform.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/platformRun.ts') },
  // Real forwarding shim — OS notifications via shell.notifyTask.
  { real: path.resolve(srcDir, 'utils/notifications.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/notificationsRun.ts') },
  // Mixed shim (drain*/setLoopContext real, requestCommandConfirmation/requestFilePermission throwing-dead) — see permissionBridgeRun.ts.
  { real: path.resolve(srcDir, 'core/agent/permissionBridge.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/permissionBridgeRun.ts') },
  // Real forwarding shim (cu.setState) + sidecar-local isSessionWindowHidden mirror — see computerUseStatusRun.ts (documented drift finding).
  { real: path.resolve(srcDir, 'core/agent/computerUseStatus.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/computerUseStatusRun.ts') },
  // Whole-module barrel redirect — builtins.ts drags all ~19 tool-definition files + registry.ts; only clearAllSkillHooks/setComputerUseBatchMode/setSkipAutoScreenshot are consumed sidecar-side — see builtinsRun.ts.
  { real: path.resolve(srcDir, 'core/tools/builtins.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/builtinsRun.ts') },
  // Real forwarding shim (replaceMessageById via pushFrame, isMessageWrittenToDisk via REQUEST) — see conversationStorageRun.ts.
  { real: path.resolve(srcDir, 'core/session/conversationStorage.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/conversationStorageRun.ts') },
  // In-sidecar direct call shim (nested nested subagent shares the parent main-loop run's ports) — see subagentRunnerRun.ts.
  { real: path.resolve(srcDir, 'core/agent/subagentRunner.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/subagentRunnerRun.ts') },
  // Throwing bundle-graph-only shims for agentLoop.ts's fire-and-forget
  // dynamic-import().catch(() => {}) call sites — each already tolerates a
  // rejected import at its sole call site, so throwing is a safe, documented
  // feature gap, not a crash. See each shim's own doc for the specific
  // reasoning (memdir/extractor.ts is a design doc §6 explicit exclusion;
  // usageTracker.ts and computerTools.ts's closeAxSession are new findings,
  // flagged in the report).
  { real: path.resolve(srcDir, 'core/memdir/extractor.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/memdirExtractorRun.ts') },
  // P1-3B-3A finding: P1-3a's assumption ("nothing imports memdir/paths.ts
  // directly once memdir/scan.ts is redirected — memdirScan.ts uses its own
  // sibling memdirPaths.ts helper instead") no longer holds now that
  // agentLoop.ts's real graph includes `skill/loader.ts`, which imports
  // `sanitizePath` from `core/memdir/paths.ts` DIRECTLY (bypassing scan.ts
  // entirely). Reuses the EXISTING `memdirPaths.ts` sidecar-local helper
  // (already real, fs-backed, byte-identical `sanitizePath` logic — see its
  // own doc) as a first-class shim target, not just scan.ts's private
  // sibling. `getMemoryEntrypoint`/`isMemoryPath`/`_resetCachedHome` are NOT
  // covered (not consumed by skill/loader.ts or any other sidecar-reachable
  // caller, verified by grep) — real module's export surface is a superset,
  // this shim intentionally covers only what's used.
  { real: path.resolve(srcDir, 'core/memdir/paths.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/memdirPaths.ts') },
  { real: path.resolve(srcDir, 'core/llm/usageTracker.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/usageTrackerRun.ts') },
  { real: path.resolve(srcDir, 'core/tools/definitions/computerTools.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/computerToolsAxRun.ts') },
  // Legitimate no-op — enterprise error telemetry, same class as langfuseRun.ts. Reached via agentLoop.ts's reportError -> consoleError.ts -> getTelemetryTarget() -> useEnterpriseStore.
  { real: path.resolve(srcDir, 'utils/consoleTelemetryTarget.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/consoleTelemetryTargetRun.ts') },
  // Real BEHAVIOR fix, not an import-purity issue — the real module's
  // getSessionOutputDir() unconditionally returns null under isTauriEnv()'s
  // always-false-in-Node check, which would silently disable
  // saveUserImagesToDisk() for every sidecar-run main loop even though its
  // underlying fs/path calls work fine. See sessionDirRun.ts.
  { real: path.resolve(srcDir, 'core/session/sessionDir.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/sessionDirRun.ts') },
  // P1-3B-4 fix — real forwarding shim (drainQueuedInputs/clearInputQueue →
  // input.consumed notify, everything else pass-through) so mid-task queued
  // input works for a sidecar-run main loop — see userInputQueueRun.ts.
  { real: path.resolve(srcDir, 'core/agent/userInputQueue.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/userInputQueueRun.ts') },
  // P1-3d-4 additions (docs/2026-07-21-phase1-p3d-tool-migration-design.md
  // §5 row "3d-4") — migrating the read-path file tools
  // (read_file/list_directory/search_files/find_files) into
  // `localTools/index.ts` requires `core/tools/definitions/fileTools.ts` to
  // be bundle-safe as a WHOLE MODULE (ES module semantics: importing any one
  // named export evaluates every top-level import in the file, including
  // ones only used by the write/edit tools this batch does NOT migrate).
  // Real forwarding shim (in-process calls to fsHost.ts, no RPC needed since
  // we ARE the sidecar now) — see fsBridgeRun.ts's module doc.
  { real: path.resolve(srcDir, 'core/tools/fsBridge.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/fsBridgeRun.ts') },
  // Dragged in ONLY via fileTools.ts's write_file/edit_file. P1-3d-4 shipped
  // both as THROWING bundle-graph-only shims (write_file/edit_file weren't
  // locally-executed yet). P1-3d A-write registers write_file/edit_file in
  // localTools/index.ts, so both are now REAL forwarding shims — a
  // fire-and-forget NOTIFICATION (defaultWorkspaceRun.ts's
  // `workspace.bindFromWrite`) and an awaited REQUEST
  // (aiEditSnapshotsRun.ts's `snapshot.beforeAiEdit`) back to the shell,
  // where the real bindWorkspaceFromWrite/snapshotBeforeAiEdit (with their
  // real store writes) run — see each shim's own doc.
  { real: path.resolve(srcDir, 'core/agent/defaultWorkspace.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/defaultWorkspaceRun.ts') },
  { real: path.resolve(srcDir, 'utils/aiEditSnapshots.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/aiEditSnapshotsRun.ts') },
  // P1-3d-5 slice 2a/2b (docs/2026-07-21-phase1-p3d-tool-migration-design.md)
  // — `commandTools.ts` (`run_command`) shims. LIVE since slice 2b registered
  // `run_command` in `localTools/index.ts` (`SIDE_EFFECTING_LOCAL_TOOLS`):
  // a sidecar-run `run_command` executes locally and reaches both shims at
  // runtime. Real-machine approval smoke passed 2026-07-26 (approve / deny /
  // dir-memory / trash / safe-command baseline — see memory
  // project-runtime-extraction-electron-shell).
  //
  // Real forwarding shim (`workspace.authorizedWritablePaths` REQUEST) — the
  // shell-only `authorizedWorkspaces` map has no sidecar-local equivalent, see
  // authorizedPathsReaderRun.ts's doc.
  { real: path.resolve(srcDir, 'core/agent/ports/authorizedPathsReader.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/authorizedPathsReaderRun.ts') },
  // Real forwarding shim (`shell.sandboxBlocked` NOTIFICATION) — the real
  // module's toast/settings-store coupling has no sidecar-local equivalent,
  // see sandboxRecoveryRun.ts's doc.
  { real: path.resolve(srcDir, 'core/sandbox/recovery.ts'), shim: path.resolve(__dirname, '../sidecar/src/shims/sandboxRecoveryRun.ts') },
];

/**
 * Bare node_modules package specifiers — not `src/`-relative files, so they
 * can't go through the generic `SHIM_TARGETS`/`shimMap` mechanism above
 * (which resolves the REAL side via `path.resolve(srcDir, ...)`). Redirected
 * directly by bare specifier instead, registered in `shimPlugin` below
 * BEFORE `bundleGraphGuardPlugin`'s blanket `@tauri-apps/*` rejection ever
 * sees them:
 *   - `@tauri-apps/api/core`'s `invoke` → `native.invoke` reverse REQUEST,
 *     see `tauriCoreInvokeRun.ts`.
 *   - `@tauri-apps/plugin-fs` → direct `node:fs/promises` calls (same
 *     machine, no wire round-trip), see `pluginFsRun.ts`.
 *   - `@tauri-apps/api/path` → `node:path`/`node:os` + spawn-time bootstrap
 *     env vars for the two Tauri-only directories, see `tauriPathRun.ts` and
 *     `bootstrap.ts`.
 *   - `@tauri-apps/plugin-os` → `node:os.platform()` mapping (P1-3d-4 —
 *     `core/tools/helpers/toolHelpers.ts`'s unconditional top-level import,
 *     dragged in by the read-path file tools this batch migrates even
 *     though its only consumer, `getSystemInfoData()`, is never called
 *     locally), see `pluginOsRun.ts`.
 */
const TAURI_CORE_SHIM = path.resolve(__dirname, '../sidecar/src/shims/tauriCoreInvokeRun.ts');
const TAURI_PLUGIN_FS_SHIM = path.resolve(__dirname, '../sidecar/src/shims/pluginFsRun.ts');
const TAURI_API_PATH_SHIM = path.resolve(__dirname, '../sidecar/src/shims/tauriPathRun.ts');
const TAURI_PLUGIN_OS_SHIM = path.resolve(__dirname, '../sidecar/src/shims/pluginOsRun.ts');
for (const shimPath of [TAURI_CORE_SHIM, TAURI_PLUGIN_FS_SHIM, TAURI_API_PATH_SHIM, TAURI_PLUGIN_OS_SHIM]) {
  if (!existsSync(shimPath)) throw new Error(`[build-sidecar] missing shim file: ${shimPath}`);
}

for (const { real, shim } of SHIM_TARGETS) {
  if (!existsSync(real)) throw new Error(`[build-sidecar] shim target source moved or renamed: ${real}`);
  if (!existsSync(shim)) throw new Error(`[build-sidecar] missing shim file: ${shim}`);
}

const shimMap = new Map(SHIM_TARGETS.map(({ real, shim }) => [real, shim]));

/**
 * Redirects the shimmed modules to their sidecar-local replacement, matching
 * on the fully-RESOLVED absolute path rather than the import specifier
 * string (a relative import and a `@/`-aliased import can both reach the
 * same file).
 *
 * P1-3B-3A FIX: this used to be narrowly filtered by a keyword substring of
 * the specifier (`/logger|compatEvents|.../i`), on the theory that a
 * false-positive filter match is harmless (it just falls through to default
 * resolution when `shimMap` has no entry for the resolved path). That
 * reasoning covers false POSITIVES but missed the false NEGATIVE case:
 * a bare same-directory relative import — e.g. `core/memdir/relevance.ts`'s
 * `import { scanMemoryFilesCached } from './scan'`, or `memdir/scan.ts`'s
 * OWN `import { getMemoryDir } from './paths'` — contains no keyword at all
 * (no "memdir" substring in `'./scan'`/`'./paths'`), so the filter never
 * even INVOKED this handler for that edge, and esbuild's DEFAULT resolution
 * loaded the REAL file, completely bypassing the redirect that worked fine
 * for OTHER edges reaching the exact same resolved path via a keyword-laden
 * specifier (e.g. `subagentLoop.ts`'s `import('../memdir/scan')`). Found via
 * `ABU_SHIM_DEBUG=1 node scripts/build-sidecar.mjs` tracing every resolution
 * of a specifier containing "memdir" — the redirect that DID succeed masked
 * the one that silently didn't, since esbuild treats each distinct
 * (specifier, resolveDir) pair as its own resolution, loading BOTH the
 * shimmed AND the real content as separate bundled modules when only one
 * edge is caught.
 *
 * Fixed by resolving EVERY import (no specifier filter) and checking
 * `shimMap` unconditionally — correctness over the now-irrelevant
 * micro-optimization (this is a one-off build script, not a hot path).
 */
const shimPlugin = {
  name: 'abu-sidecar-shims',
  setup(pluginBuild) {
    // Bare node_modules package specifier — @tauri-apps/api/core's `invoke`.
    // Matched BEFORE the generic handler below (registration order =
    // evaluation order for esbuild onResolve within one plugin) and BEFORE
    // bundleGraphGuardPlugin's blanket `@tauri-apps/*` rejection (plugin
    // order: shimPlugin runs first) — see TAURI_CORE_SHIM's doc.
    pluginBuild.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => {
      return { path: TAURI_CORE_SHIM };
    });
    pluginBuild.onResolve({ filter: /^@tauri-apps\/plugin-fs$/ }, () => {
      return { path: TAURI_PLUGIN_FS_SHIM };
    });
    pluginBuild.onResolve({ filter: /^@tauri-apps\/api\/path$/ }, () => {
      return { path: TAURI_API_PATH_SHIM };
    });
    pluginBuild.onResolve({ filter: /^@tauri-apps\/plugin-os$/ }, () => {
      return { path: TAURI_PLUGIN_OS_SHIM };
    });

    pluginBuild.onResolve({ filter: /.*/ }, async (args) => {
      // Recursion guard: this handler calls build.resolve() below to find out
      // where the specifier ACTUALLY lands, which re-enters esbuild's
      // resolution pipeline (and this same onResolve callback, since the
      // filter now matches everything). Bail out to default resolution on
      // the re-entrant call instead of looping forever.
      if (args.pluginData?.abuShimResolving) return null;
      // Skip bare node_modules packages other than the one handled above —
      // resolving them through this path is unnecessary work and
      // `bundleGraphGuardPlugin` already has its own dedicated check for
      // `@tauri-apps/*`; non-relative, non-aliased specifiers can never
      // resolve to a `src/`-relative shimMap entry anyway.
      if (!args.path.startsWith('.') && !args.path.startsWith('@/')) return null;

      const resolved = await pluginBuild.resolve(args.path, {
        resolveDir: args.resolveDir,
        kind: args.kind,
        importer: args.importer,
        pluginData: { abuShimResolving: true },
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };

      const shimPath = shimMap.get(resolved.path);
      if (process.env.ABU_SHIM_DEBUG && shimPath) {
        console.error('[shim-debug]', args.path, '->', resolved.path, '-> SHIMMED', shimPath);
      }
      // Self-import exception (P1-3b-4): a "wrap the REAL module + add a side
      // effect" shim (e.g. userInputQueueRun.ts, which forwards to the real
      // queue and additionally emits `input.consumed` on drain/clear) imports
      // its OWN target to reach the real implementation. If the importer IS
      // that target's shim, do NOT redirect — otherwise the shim's
      // `import ... from '<target>'` resolves back to itself → infinite
      // recursion (RangeError: Maximum call stack size exceeded, seen at
      // runtime as a sidecar -32603 on the very first drainQueuedInputs).
      // The real module still loads (as a separate bundled module); it must be
      // bundle-safe on its own (userInputQueue.ts is a pure in-memory Map, no
      // store/Tauri draggers — the guard below still enforces this).
      if (shimPath && args.importer === shimPath) return null;
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
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
      __ENTERPRISE_BUILD__: JSON.stringify(false),
    },
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
