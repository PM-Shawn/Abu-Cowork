/**
 * Sidecar-local tool registry (P1-3d-1, docs/2026-07-21-phase1-p3d-tool-migration-design.md
 * §1/§2, P1-3D-SCOUT-REPORT.md §1/§5).
 *
 * Maps a small set of tool NAMES to their REAL `execute()` implementation,
 * imported DIRECTLY from each tool-definition file — bypassing
 * `core/tools/builtins.ts`'s barrel entirely (that barrel is redirected
 * wholesale to `shims/builtinsRun.ts` by `build-sidecar.mjs`, because
 * importing even one re-export drags in ~19 tool-definition files +
 * `registry.ts`'s store/mcp/enterprise graph — see that shim's module doc).
 * Importing these specific files directly is safe ONLY because each one's
 * transitive dependency graph is either pure or already covered by an
 * existing `SHIM_TARGETS` entry — verified file-by-file, not assumed:
 *
 *   - `widgetTools.ts` (`show_widget`/`read_me`): pure validation/lookup,
 *     zero IO. Deps: `../../../types` (types only), `../toolNames` (pure
 *     const object), `../../../i18n` (real shim, `shims/i18nRun.ts` — full
 *     dict + run-context locale resolution), `../../widget/guidelines` (+
 *     `./designSystem`, verified pure — no imports beyond that).
 *   - `webTools.ts` (`http_fetch`/`web_search`): `../../llm/tauriFetch`
 *     (real shim, `shims/tauriFetch.ts` → `globalThis.fetch`),
 *     `../../agent/ports/settingsReader` (bundle-graph shim,
 *     `shims/settingsReaderRun.ts` — see the `setSettingsReader` wiring note
 *     below, REQUIRED for `web_search` to work), dynamic
 *     `import('@mozilla/readability')`/`import('linkedom')` (pure npm
 *     packages, already a `package.json` dependency, no Tauri/store
 *     surface), dynamic `import('../../search/providers')` (verified: only
 *     imports `../llm/tauriFetch`, no other Tauri/store reach).
 *   - `fileTools.ts` (`read_file`/`list_directory`/`search_files`/
 *     `find_files` — P1-3d-4; `write_file`/`edit_file` — P1-3d A-write): see
 *     that section's own doc block below for the FULL bundle-feasibility
 *     trace (P1-3d-4 needed THREE new shims, not zero —
 *     `fsBridge.ts`/`defaultWorkspace.ts`/`aiEditSnapshots.ts`, plus two
 *     bare-package additions, `@tauri-apps/plugin-os` and
 *     `@tauri-apps/plugin-fs`'s `lstat` — this summary line is not the full
 *     story, read the block below it). P1-3d A-write RESOLVES the last two
 *     of those three shims from throwing stubs into real forwarding shims
 *     (see the "P1-3d A-write" section below) — no NEW bundle-graph work was
 *     needed, since `write_file`/`edit_file`'s whole dependency graph was
 *     already dragged in and made bundle-safe by P1-3d-4 (it just wasn't
 *     REACHED yet, because neither tool was registered here).
 *   - `processImageTool.ts` (`process_image` — P1-3d-5 slice 1, extracted
 *     from `mediaTools.ts` to shed `generateImageTool`'s store imports):
 *     `../../../types`/`../toolNames` (pure, same as above), `utils/platform`
 *     + `utils/pathUtils` (pure), `../helpers/toolHelpers`'s command builders
 *     (pure string builders — the whole FILE is already bundle-safe via
 *     `fileTools.ts`'s read-path tools above, see this file's own doc block
 *     below), `../../sandbox/config` (already dragged in by
 *     `search_files`/`find_files`), `@tauri-apps/api/core`'s `invoke` (real
 *     shim, `shims/tauriCoreInvokeRun.ts`, same as the file tools' shell-out
 *     calls). See the "P1-3d-5 slice 1: process_image" section below for the
 *     full approval-parity and `readOnly` trace.
 *   - `commandTools.ts` (`run_command` — P1-3d-5 slice 2b): `utils/platform`
 *     (pure, already imported by THIS file itself for `isWindows()`),
 *     `utils/pythonRuntime`'s `resolveCommandPython` (its own deps —
 *     `@tauri-apps/api/path`'s `resolveResource` and `@tauri-apps/plugin-fs`'s
 *     `exists` — are both bare-package shims already registered for the file
 *     tools above, `shims/tauriPathRun.ts`/`shims/pluginFsRun.ts`),
 *     `../../sandbox/config` (already dragged in by `search_files`/
 *     `find_files`; its own `getSettingsReader()`/`invoke()` resolve to the
 *     same `shims/settingsReaderRun.ts`/`shims/tauriCoreInvokeRun.ts` shims
 *     `web_search`/every local tool here already relies on),
 *     `../../agent/ports/workspaceReader` (already shimmed,
 *     `shims/workspaceReaderRun.ts`), `../../agent/ports/authorizedPathsReader`
 *     and `../../sandbox/recovery` (P1-3d-5 slice 2a's two REAL forwarding
 *     shims, `shims/authorizedPathsReaderRun.ts`/`shims/sandboxRecoveryRun.ts`
 *     — registered in `SHIM_TARGETS` ahead of this flip but not REACHED by
 *     the bundle graph until this registration), the pure `../toolNames` and
 *     `../readOnlyDetector`'s `isReadOnlyCommand` (only depends on
 *     `utils/platform`'s `isWindows`), and `../helpers/toolHelpers`'s
 *     `CommandOutput` (an `import type` — erased at compile time, zero
 *     runtime footprint). See the "P1-3d-5 slice 2b: run_command" section
 *     below for the full approval-parity/readOnly/auth-paths-failure trace.
 *
 * `createReverseToolInvoker.executeAnyTool` (`agentLoopHost.ts`) checks
 * this registry FIRST: a hit runs locally (no RPC round-trip); a miss falls
 * through to the existing reverse `tool.invoke` path, UNCHANGED — see that
 * function for the local-failure-falls-back-to-reverse discipline.
 *
 * ── settingsReader wiring (required for `web_search`) ───────────────────
 * `webSearchTool.execute()` calls the BARE port getter
 * `getSettingsReader()` (not an injected `AgentLoopOptions.settingsReader`
 * — that only covers `agentLoop.ts`'s own call sites, see
 * `agentRunContext.ts`'s "provably dead" note about that fallback). Inside
 * the sidecar bundle this bare getter resolves to
 * `shims/settingsReaderRun.ts`, whose DEFAULT throws (by design — it exists
 * to catch a `subagentHost.ts` wiring bug, see its own doc). Nothing in the
 * sidecar previously called `setSettingsReader(...)`, because nothing
 * previously reached that bare getter at runtime. `agentLoopHost.ts`'s
 * `handleAgentRun` now calls `setSettingsReader(getSettingsMirrorReader())`
 * once per run (idempotent, cheap) so this bare getter resolves to the SAME
 * live settings mirror `agentLoop.ts` itself reads through its injected
 * reader — see that call site's comment for the full rationale.
 *
 * ── Deliberately NOT included here ───────────────────────────────────────
 * `tool_search`: its `execute()` calls `getAllTools()` imported from
 * `core/tools/registry.ts` (`toolSearchTool.ts:3`) — `registry.ts` drags
 * `mcpManager`/`useChatStore`/`@tauri-apps/api/path`'s `homeDir`/enterprise
 * policy, all forbidden by `bundleGraphGuardPlugin`. The sidecar's
 * Agent Loop therefore keeps this tool on the reverse `tool.invoke` path.
 * The trusted turn context carries only the policy-filtered deferred tool
 * names across RPC; shell-side `toolSearchTool.execute()` intersects those
 * names with its real registry and returns schemas. After success, the
 * sidecar-hosted loop deterministically recomputes the same matches from the
 * trusted query and deferred list, then promotes them. This avoids
 * importing the shell registry here and avoids cross-process module state.
 *
 * ── P1-3d-1 gap CLOSED by P1-3d-3 ────────────────────────────────────────
 * `registry.ts`'s `executeAnyTool` runs an enterprise-policy pre-check
 * (`getCurrentPolicy()`/`checkTool()`, `registry.ts:389-405`) against EVERY
 * tool, including read-only ones, before invoking `execute()`.
 * `getCurrentPolicy()` reads `useEnterpriseStore` (`@/stores/enterpriseStore`),
 * which `bundleGraphGuardPlugin` permanently forbids from the sidecar
 * bundle — so a tool executed here can never run that pre-check itself.
 * P1-3d-1 shipped with this gap flagged (locally-executed tools skipped the
 * policy pre-check entirely — a real behavior difference from the reverse
 * path). P1-3d-3 (docs/2026-07-21-phase1-p3d-tool-migration-design.md §3)
 * closes it: `agentLoopHost.ts`'s `executeAnyTool` now calls
 * `checkLocalToolApproval` — an `approval.check` reverse RPC to the shell,
 * answered by `checkToolApproval` (registry.ts, the SAME chain the reverse
 * `tool.invoke` path runs) — BEFORE every local dispatch below, and only
 * proceeds to `executeLocalTool` on an explicit `{decision:'allow'}`. Every
 * tool registered here is Tier A (zero command/path approval surface), so in
 * practice this adds exactly the policy pre-check and nothing else; a future
 * non-Tier-A local tool gets the full chain for free via the same gate.
 *
 * ── P1-3d-4: read-path file tools (read_file/list_directory/search_files/
 * find_files) ─────────────────────────────────────────────────────────────
 * UNLIKE Tier A (zero approval surface), these four sit behind
 * `FILE_TOOL_PATH_MAP` (`registry.ts`) — an out-of-workspace read needs
 * authorization. That's ORTHOGONAL to local-vs-reverse execution and already
 * handled by the same `approval.check` gate every entry here goes through
 * (P1-3d-3, `agentLoopHost.ts`'s `checkLocalToolApproval`) — nothing
 * file-tool-specific needed on that front; see this module's "P1-3d-1 gap
 * CLOSED by P1-3d-3" section above, which applies identically here.
 *
 * `fileTools.ts` exports SEVEN tools from one file; SIX are registered below
 * as of P1-3d A-write (read/list/search/find — P1-3d-4 — plus write/edit —
 * P1-3d A-write; NOT delete, still out of scope). Because ES module
 * semantics evaluate every top-level import in a file regardless of which
 * exports are actually used, importing ANY of `fileTools.ts`'s exports drags
 * in ALL of its top-level imports — including ones only
 * `writeFileTool`/`editFileTool`/`deleteFileTool` need. Verified empirically
 * (`npm run build:sidecar` against a probe import), not assumed: this
 * required THREE new bundle-graph fixes beyond what P1-3d-1 needed —
 *
 *   1. `core/tools/fsBridge.ts` — the SHELL-side fs bridge (P1-2a): it calls
 *      OUT to the sidecar over `sidecarManager.ts`'s RPC client, with a
 *      `@tauri-apps/plugin-fs` fallback — neither makes sense running INSIDE
 *      the sidecar (there's no "sidecar of the sidecar", and
 *      `sidecarManager.ts` itself imports `@tauri-apps/api/event`, forbidden).
 *      New shim `shims/fsBridgeRun.ts` calls `fsHost.ts`'s REAL handlers
 *      directly, in-process — see that shim's own doc.
 *   2. `core/agent/defaultWorkspace.ts` — imported by `fileTools.ts` ONLY for
 *      `writeFileTool`'s `bindWorkspaceFromWrite` (not used by the four read
 *      tools), but pulls `useChatStore`/`useWorkspaceStore`/`usePermissionStore`
 *      directly — forbidden. P1-3d-4 shipped `shims/defaultWorkspaceRun.ts`
 *      as a THROWING stub (write_file wasn't locally-executed yet, so it was
 *      provably dead at the time). P1-3d A-write RESOLVES that stub into a
 *      real forwarding shim (fire-and-forget NOTIFICATION,
 *      `workspace.bindFromWrite` — see that shim's own doc), now that
 *      `write_file` IS registered below.
 *   3. `utils/aiEditSnapshots.ts` — same shape, imported ONLY for
 *      `writeFileTool`/`editFileTool`'s `snapshotBeforeAiEdit`, pulls
 *      `useChatStore`. Same P1-3d-4-throws→P1-3d-A-write-resolves history —
 *      `shims/aiEditSnapshotsRun.ts` now forwards as an AWAITED REQUEST
 *      (`snapshot.beforeAiEdit` — the real call sites `await` this BEFORE
 *      writing to disk, so unlike `bindWorkspaceFromWrite` it can't be
 *      fire-and-forget; see that shim's own doc for the fail-open contract
 *      it preserves at the RPC boundary).
 *
 * Plus two bare-package additions surfaced by the SAME whole-module-import
 * effect, both via `core/tools/helpers/toolHelpers.ts` (used by `read_file`'s
 * image/office/archive branches) and `core/tools/pathSafety.ts` (used by
 * `deleteFileTool`, again dragged in incidentally):
 *   - `@tauri-apps/plugin-os`'s `platform()` (`toolHelpers.ts`'s
 *     `getSystemInfoData()`, never called by any tool registered here) —
 *     `shims/pluginOsRun.ts`.
 *   - `@tauri-apps/plugin-fs`'s `desktopDir`/`documentDir`/`downloadDir`/
 *     `tempDir` (same function, same reason) — added to `shims/tauriPathRun.ts`
 *     — and `lstat` (`pathSafety.ts`'s `isCatastrophicDeleteTarget`, used
 *     only by `deleteFileTool`) — added to `shims/pluginFsRun.ts`.
 *
 * ── `read_file`'s PDF/PPTX/archive branches — NOT bundle-unsafe, but
 * FUNCTIONALLY unsupported locally (see `READ_FILE_UNSUPPORTED_LOCALLY`) ──
 * `read_file`'s PDF branch (`fileTools.ts:111,125`), `toolHelpers.ts`'s
 * `extractPptxViaPython` (pptx via `extractOfficeText`), and
 * `listArchiveContents`'s non-Windows `.zip`/`.tar`/`.tar.gz`/`.tgz`/`.gz`
 * branches all call `invoke('run_argv_command', ...)` — a command NOT on
 * `agentLoopRunner.ts`'s `NATIVE_INVOKE_ALLOWLIST` (deliberately: it runs an
 * arbitrary argv program, unlike the fixed `run_shell_command`/`atomic_write_text`
 * already allowlisted — the design doc §5's "3d-4" row leans against adding
 * it without a specific safety case, and this batch found none strong enough
 * to justify one). Reached locally, `native.invoke` rejects with "not
 * allowlisted" — but EACH of these call sites already has its OWN internal
 * `try/catch` around the `invoke()` call (existing behavior, there to
 * degrade gracefully when `pdftotext`/`python3`/`unzip`/`tar` aren't
 * installed on the shell's machine) that SWALLOWS that rejection and returns
 * a normal string `ToolResult` (a misleading "install pdftotext" / "Python3
 * not available" hint) — it does NOT throw past `read_file`'s own outer
 * `try/catch` either. So a plain `entry.tool.execute()` call for these
 * extensions would silently succeed with a WRONG, misleading result instead
 * of naturally falling back — verified by reading the actual catch/return
 * structure, not assumed from the design doc's framing (which describes this
 * as "PDF 分支自然回退" — that does not hold as written; see the report).
 * `READ_FILE_UNSUPPORTED_LOCALLY` pre-checks the extension BEFORE calling
 * the real `readFileTool.execute()` and throws `LocalToolUnsupportedError`
 * instead — recognized specially by `executeLocalTool`'s catch below (which
 * RE-throws it, unlike every other tool-level error) so the caller's
 * existing `readOnly`-fallback path (`agentLoopHost.ts`) takes over and
 * retries via the reverse `tool.invoke` path, where the real
 * `run_argv_command` invoke runs in the shell and actually works.
 *
 * ── P1-3d A-write: write-path file tools (write_file/edit_file) ─────────────
 * 🔴 SECURITY-RELEVANT — this is the first WRITE-capable pair registered
 * here (every P1-3d-1/3d-4 entry above is read-only or zero-IO). Both are
 * registered with `readOnly: false` — see `LocalToolEntry.readOnly`'s doc: a
 * local DISPATCH-LAYER failure (as opposed to a normal tool-level error,
 * which `executeLocalTool` already catches and returns as an error-string
 * `ToolResult`, same as every other tool) is RE-THROWN by
 * `agentLoopHost.ts`'s caller instead of falling back to the reverse
 * `tool.invoke` path — "once local execution starts, it's committed", no
 * double-write risk. This is the SAME generic mechanism P1-3d-1 already
 * built and tested (`agentLoopHost.test.ts`'s "local tool dispatch" describe
 * block already covers the readOnly:false rethrow branch generically, tool-
 * name-agnostic) — nothing new needed there.
 *
 * Write-path approval (`FILE_TOOL_PATH_MAP`'s `write_file`/`edit_file` →
 * `checkWritePath`, registry.ts) goes through the EXACT SAME `approval.check`
 * gate every entry in this file already goes through (P1-3d-3's
 * `checkLocalToolApproval`, called unconditionally before ANY local dispatch
 * in `agentLoopHost.ts` — see the "P1-3d-1 gap CLOSED by P1-3d-3" section
 * above). `checkToolApproval` (registry.ts) is name-agnostic — it doesn't
 * know or care whether the caller intends to execute the tool locally or
 * reverse it to the shell, so an out-of-workspace write triggers the SAME
 * user-facing authorization prompt (`onRequireFilePermission`, resolved
 * shell-side by the session's real callback) regardless of which path
 * dispatches it. Nothing file-tool-specific was needed for this batch on the
 * approval front — the existing gate already covers `write`-capability path
 * checks identically to `read`.
 *
 * Neither tool needs a `LocalToolUnsupportedError`-style pre-check wrapper
 * (unlike `readFileLocalTool` above) — `write_file`/`edit_file` have no
 * PDF/Office/archive branch; every code path they can take
 * (`fsBridge.ts`'s `writeTextFile`/`readTextFile`/`exists`, `pathUtils.ts`'s
 * `ensureParentDir` → `@tauri-apps/plugin-fs`'s `mkdir`, both already
 * bundle-safe via `fsBridgeRun.ts`/`pluginFsRun.ts`) runs correctly locally.
 *
 * ── P1-3d-5 slice 1: process_image ──────────────────────────────────────────
 * `processImageTool` was extracted from `mediaTools.ts` into its own file
 * (`definitions/processImageTool.ts`) specifically so it could be imported
 * here WITHOUT dragging in `generateImageTool`'s store imports
 * (`getUsableImageBackend` from `stores/settingsStore`, `useWorkspaceStore`)
 * — both forbidden by `bundleGraphGuardPlugin`. `process_image.execute()`
 * itself uses no store and no toast; every dependency (`pathUtils`,
 * `utils/platform`, `toolHelpers`'s pure command builders, `sandbox/config`)
 * is either pure or already bundle-safe — `sandbox/config`'s
 * `isSandboxEnabled`/`isNetworkIsolationEnabled` and `toolHelpers.ts` as a
 * whole module are BOTH already dragged in by the file tools above
 * (`search_files`/`find_files` use the former; `read_file`'s office/archive
 * branches use the latter), so this adds zero new bundle-graph surface.
 *
 * Approval parity (verified against `registry.ts`'s `checkToolApproval`):
 * `process_image` is NOT in `FILE_TOOL_PATH_MAP` (only
 * `read_file`/`list_directory`/`write_file`/`edit_file`/`delete_file`/
 * `search_files`/`find_files` are) and the command-safety branch only
 * triggers `name === TOOL_NAMES.RUN_COMMAND` — `process_image` calls
 * `invoke('run_shell_command', ...)` directly, bypassing the `run_command`
 * tool entirely, so `analyzeCommand` never runs for it either. So in the
 * reverse path `process_image` gets NO tool-specific approval gate — only
 * the universal enterprise-policy pre-check, which every local dispatch
 * already goes through via P1-3d-3's `checkLocalToolApproval` regardless of
 * which tool. Registering it here adds no gate it lacks and drops none it
 * has.
 *
 * `readOnly: false` (unlike the Tier-A read-only tools above) — despite
 * having no tool-specific approval gate, `process_image` is NOT zero-IO: it
 * writes/overwrites a real file at `output_path` via a shell command, the
 * same side-effect shape as `write_file`/`edit_file` above (P1-3d A-write).
 * `LocalToolEntry.readOnly`'s doc is explicit: "A future tool with side
 * effects registered here MUST set this to false" — so the caller
 * (`agentLoopHost.ts`) re-throws a local dispatch-layer failure instead of
 * retrying via the reverse `tool.invoke` path, avoiding a double-run of the
 * image-processing shell command.
 *
 * ── P1-3d-5 slice 2b: run_command ────────────────────────────────────────────
 * The flip: `run_command`'s bundle-graph plumbing (the `WorkspaceReader`/
 * `AuthorizedPathsReader` ports plus the two real forwarding shims for
 * authorized-paths and sandbox-recovery) landed in slice 2a but wasn't
 * REACHED by the sidecar's actual bundle graph until THIS registration — see
 * this module doc's `commandTools.ts` import-trace bullet above for the full
 * per-dependency verification (each dep is either pure or already shimmed;
 * nothing new needed here).
 *
 * Approval parity (verified against `registry.ts`'s `checkToolApproval`):
 * `run_command` is NOT in `FILE_TOOL_PATH_MAP`, but IS the one tool the
 * command-safety branch targets — `name === TOOL_NAMES.RUN_COMMAND`
 * (registry.ts:295) runs `analyzeCommand` (:298) + `analyzeCommandBoundary`
 * (:311) against the real `input.command`. That check runs SHELL-side,
 * reached via the exact same `approval.check` reverse RPC every local
 * dispatch in this file already goes through UNCONDITIONALLY before any local
 * execution (P1-3d-3's `checkLocalToolApproval` — see the "P1-3d-1 gap
 * CLOSED by P1-3d-3" section above). So registering `run_command` here does
 * not bypass commandSafety, does not duplicate it locally, and does not
 * weaken it: the allow/deny decision still runs against the shell-authoritative
 * command-safety rules, and local execution only starts on an explicit
 * `{decision:'allow'}` — this is a plumbing/registration change, not a new
 * approval implementation.
 *
 * `readOnly: false` (SIDE_EFFECTING_LOCAL_TOOLS, same array as
 * `process_image`) — `run_command` spawns an arbitrary shell command via
 * `invoke('run_shell_command')`; once that spawn starts there is no safe way
 * to "retry" it via the reverse `tool.invoke` path without risking a
 * double-run of a possibly-destructive command (rm, git push, ...) — same
 * "once local execution starts, it's committed" discipline as
 * `write_file`/`edit_file`/`process_image` above.
 *
 * ── Auth-paths RPC failure — accepted fail-closed behavior (code-review
 * finding; decision already made, not re-litigated here) ────────────────────
 * `commandTools.ts`'s `execute()` calls
 * `getAuthorizedPathsReader().getAuthorizedWritablePaths()` (only when
 * sandboxed) BEFORE spawning the command. In the sidecar this resolves to
 * `shims/authorizedPathsReaderRun.ts`'s reverse `workspace.authorizedWritablePaths`
 * REQUEST. If that RPC round-trip rejects (dead/slow transport, a throwing
 * shell-side handler, ...), `execute()`'s existing outer `try/catch` catches
 * it and returns a plain `Error executing command: ...` string — the
 * function returns BEFORE ever reaching `invoke('run_shell_command', ...)`,
 * so NO command spawns; no side effect. No reverse-fallback complexity was
 * added for this failure mode: the same shell↔sidecar transport that the
 * authorized-paths RPC uses is the SAME one `run_command` itself needs a
 * moment later to actually spawn the command (`invoke('run_shell_command')`
 * is ALSO a reverse call over that transport, per this module's own doc on
 * `native.invoke`) — so a transport broken enough to fail the authorized-paths
 * query dooms local `run_command` regardless of what this function does in
 * response. Erroring early on that failure is an honest fail-closed signal
 * (the model sees a clear error and can retry/report), never a silent
 * under-authorization — the alternative (swallowing the RPC failure and
 * proceeding with an empty authorized-paths list) would UNDER-authorize the
 * OS-level sandbox for that run, a strictly worse outcome than failing
 * loudly. See `commandTools.test.ts`'s auth-paths-rejection regression test:
 * mocks a rejecting `getAuthorizedWritablePaths`, asserts the returned
 * string contains "Error executing command" AND that `invoke` was never
 * called with `'run_shell_command'`.
 *
 * ── OS-permission-guide parity (was a known gap through P1-3d, now closed) ──
 * `executeAnyTool` (registry.ts, the REVERSE path) wraps an OS-permission-
 * shaped error string (`EACCES`/`EPERM`/"operation not permitted"/"access is
 * denied") in a friendly macOS/Windows permission-grant hint
 * (`formatOSPermissionGuide`) for every `FILE_TOOL_PATH_MAP` tool. For a while
 * `executeLocalTool` (this file) did NOT apply that formatting, so a locally-
 * executed read/write/edit that failed with a real OS permission error (e.g. a
 * macOS TCC-protected folder) returned the RAW error string instead of the
 * guided one — a UX/messaging difference, never a safety one (the op still
 * correctly fails either way, nothing is silently allowed through). Now closed:
 * `executeLocalTool`'s string-result branch runs the SAME
 * `applyOSPermissionGuideIfNeeded` helper (the pure `osPermissionGuide` module,
 * shared with registry.ts's reverse path — importing it from registry.ts itself
 * would drag chatStore into the sidecar bundle, which the build guard forbids),
 * so both paths emit the identical guided message. Not
 * truncated when guided (the raw error is short), matching the reverse path.
 */
import type { ToolDefinition, ToolResult, ToolExecutionContext } from '@/types';
import { showWidgetTool, readMeTool } from '@/core/tools/definitions/widgetTools';
import { httpFetchTool, webSearchTool } from '@/core/tools/definitions/webTools';
import {
  readFileTool,
  listDirectoryTool,
  searchFilesTool,
  findFilesTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
} from '@/core/tools/definitions/fileTools';
import { processImageTool } from '@/core/tools/definitions/processImageTool';
import { runCommandTool } from '@/core/tools/definitions/commandTools';
import { getFileExtension, ARCHIVE_EXTENSIONS } from '@/core/tools/helpers/toolHelpers';
import { isWindows } from '@/utils/platform';
import { truncateToolResult } from '@/core/context/truncation';
import { applyOSPermissionGuideIfNeeded } from '@/core/tools/osPermissionGuide';

/**
 * Thrown by a locally-registered tool's execute() WRAPPER (never by a real
 * tool's own `execute()` — those stay untouched) to signal "this specific
 * input can't be served locally, escalate to the reverse `tool.invoke`
 * path" — as opposed to a genuine tool-level error, which stays a normal
 * error-string `ToolResult` (unchanged existing behavior for every other
 * case). See `executeLocalTool`'s catch and `READ_FILE_UNSUPPORTED_LOCALLY`'s
 * doc for the one case that uses this today.
 */
class LocalToolUnsupportedError extends Error {}

/**
 * `true` iff `read_file`'s LOCAL execution of `filePath` would hit a branch
 * that depends on `invoke('run_argv_command', ...)` — not on the
 * `native.invoke` allowlist, so it would silently degrade to a misleading
 * "tool not installed" message rather than actually extracting the content
 * (see this module's doc's "PDF/PPTX/archive branches" section for the full
 * evidence trail). Mirrors `fileTools.ts`'s PDF check and
 * `toolHelpers.ts`'s `extractOfficeText`/`listArchiveContents` branching —
 * a narrow, DELIBERATELY-DUPLICATED predicate (same discipline as this
 * file's own `validateRequiredFields`, which documents the same trade-off):
 * this is NOT a security decision (a mismatch just costs one extra
 * round-trip via the reverse-path fallback, never a wrong/bypassed
 * permission check — the `approval.check` gate stays wholly unaffected by
 * this predicate), so staying in sync with the real branching logic if it
 * changes is a correctness nice-to-have, not a safety requirement.
 */
function readFileUnsupportedLocally(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  if (ext === '.pdf') return true; // fileTools.ts:111,125 — always run_argv_command, no platform branch
  if (ext === '.pptx') return true; // toolHelpers.ts's extractPptxViaPython — always run_argv_command
  const isArchive = ARCHIVE_EXTENSIONS.has(ext) || filePath.endsWith('.tar.gz');
  if (!isArchive) return false;
  const archiveExt = filePath.endsWith('.tar.gz') ? '.tar.gz' : ext;
  // listArchiveContents: Windows .zip uses run_shell_command (ALLOWLISTED,
  // safe locally); every other archive branch (.zip on non-Windows, .tar,
  // .tar.gz, .tgz, .gz) uses run_argv_command. .7z/.rar hit neither — they
  // fall to a plain "not supported, use run_command" string with NO invoke
  // call at all, identical locally and via the reverse path — safe either way.
  if (archiveExt === '.zip') return !isWindows();
  return archiveExt === '.tar' || archiveExt === '.tar.gz' || archiveExt === '.tgz' || archiveExt === '.gz';
}

/**
 * Local wrapper around the REAL `readFileTool` (`fileTools.ts` itself is
 * NOT modified — see this module's doc). Same `name`/`description`/
 * `inputSchema` (so approval/validation/logging see an identical tool
 * shape); `execute` pre-checks the path extension and escalates via
 * `LocalToolUnsupportedError` for the PDF/PPTX/some-archive cases described
 * above, BEFORE doing any work — cleaner than letting the real tool attempt
 * and silently return a wrong answer, and safe to escalate pre-work since
 * `read_file` is read-only/idempotent either way.
 */
const readFileLocalTool: ToolDefinition = {
  ...readFileTool,
  execute: async (input, context) => {
    const path = typeof input.path === 'string' ? input.path : '';
    if (readFileUnsupportedLocally(path)) {
      throw new LocalToolUnsupportedError(
        `read_file: "${path}" needs run_argv_command (pdftotext/python3/unzip/tar), which is not on the sidecar's native.invoke allowlist — falling back to the reverse tool.invoke path, where the shell can run it directly.`,
      );
    }
    return readFileTool.execute(input, context);
  },
};

interface LocalToolEntry {
  tool: ToolDefinition;
  /**
   * `true` = zero side effects — safe for the caller
   * (`agentLoopHost.ts`'s `executeAnyTool`) to fall back to the reverse
   * `tool.invoke` path on a local DISPATCH-LAYER failure (idempotent
   * retry, not a double-execution risk). A future tool with side effects
   * registered here MUST set this to `false`; the caller then re-throws
   * instead of retrying — "once local execution starts, it's committed"
   * (same discipline as `agentLoopRunner.ts`'s `RunSession.committed` /
   * `selectChatAdapter.ts`'s sidecar-vs-local routing).
   */
  readOnly: boolean;
}

// Read-only / zero-side-effect tools (P1-3d-1 Tier A + P1-3d-4 read-path
// file tools) — safe to fall back to the reverse tool.invoke path on a
// local dispatch-layer failure. See LocalToolEntry.readOnly's doc.
const READ_ONLY_LOCAL_TOOLS: ToolDefinition[] = [
  showWidgetTool,
  readMeTool,
  httpFetchTool,
  webSearchTool,
  readFileLocalTool,
  listDirectoryTool,
  searchFilesTool,
  findFilesTool,
];

// Side-effecting FILE_TOOL_PATH_MAP tools (P1-3d A-write + P1-3d-5 slice 3) —
// `readOnly: false` below: once local execution starts, it's committed. A local
// dispatch-layer failure re-throws instead of retrying via the reverse
// tool.invoke path (no double-write / double-delete risk). All three are
// path-gated: their write-path approval (checkWritePath) runs shell-side via the
// approval.check gate every entry here goes through. `deleteFileTool` (P1-3d-5
// slice 3) additionally reverses `invoke('move_to_trash')` (newly allowlisted in
// agentLoopRunner.ts's NATIVE_INVOKE_ALLOWLIST) and enforces its catastrophic-
// target hard-block (root / home dir) inside its own execute() — which runs here
// in the sidecar, keeping that fail-closed guard intact (pathSafety's
// `isCatastrophicDeleteTarget` is pure/bundle-safe; tested in fileTools.test.ts).
const WRITE_LOCAL_TOOLS: ToolDefinition[] = [writeFileTool, editFileTool, deleteFileTool];

// Side-effecting, non-FILE_TOOL_PATH_MAP tools (P1-3d-5 slices 1 and 2b) —
// same `readOnly: false` discipline as WRITE_LOCAL_TOOLS above (each commits
// a real side effect once local execution starts: process_image writes
// output_path via a shell command, run_command spawns an arbitrary shell
// command), but kept in their own array since neither is a file-write tool
// in registry.ts's FILE_TOOL_PATH_MAP sense. run_command's approval is the
// commandSafety check (applied via the same approval.check gate every entry
// in this file goes through — registry.ts:295, NOT duplicated here). See
// this module's "P1-3d-5 slice 1: process_image" and "P1-3d-5 slice 2b:
// run_command" doc sections above.
const SIDE_EFFECTING_LOCAL_TOOLS: ToolDefinition[] = [processImageTool, runCommandTool];

const LOCAL_TOOLS = new Map<string, LocalToolEntry>([
  ...READ_ONLY_LOCAL_TOOLS.map((tool): [string, LocalToolEntry] => [tool.name, { tool, readOnly: true }]),
  ...WRITE_LOCAL_TOOLS.map((tool): [string, LocalToolEntry] => [tool.name, { tool, readOnly: false }]),
  ...SIDE_EFFECTING_LOCAL_TOOLS.map((tool): [string, LocalToolEntry] => [tool.name, { tool, readOnly: false }]),
]);

export function hasLocalTool(name: string): boolean {
  return LOCAL_TOOLS.has(name);
}

/**
 * `true` only for tools registered here whose local execution is safe to
 * retry via the reverse `tool.invoke` path on a dispatch-layer failure —
 * see `LocalToolEntry.readOnly`'s doc. Returns `false` for any unregistered
 * name too (fail-closed: an unknown tool is never treated as safely
 * retryable).
 */
export function isLocalToolReadOnly(name: string): boolean {
  return LOCAL_TOOLS.get(name)?.readOnly ?? false;
}

/**
 * Validate required input fields — a narrow, deliberately-duplicated copy
 * of `registry.ts`'s private `validateToolInput` (that function lives
 * inside `registry.ts`'s non-bundle-safe module, so it can't be imported
 * here). Keep the two in sync if either's contract changes.
 */
function validateRequiredFields(tool: ToolDefinition, input: Record<string, unknown>): string | null {
  if ('_parse_error' in input) {
    const requiredFields = tool.inputSchema.required ?? [];
    const requiredHint = requiredFields.length > 0 ? `\n该工具的必填参数：${requiredFields.join(', ')}` : '';
    return (
      `Error: 工具 "${tool.name}" 的调用参数不是合法 JSON，无法解析。` +
      requiredHint +
      `\n请重新调用该工具，arguments 字段必须是严格序列化的 JSON 字符串。` +
      `如果连续多次失败，可能是模型本轮输出已达上限。`
    );
  }

  const required = tool.inputSchema.required;
  if (!required || required.length === 0) return null;

  const missing = required.filter((f) => input[f] === undefined || input[f] === null);
  if (missing.length === 0) return null;

  const schemaHint = required
    .map((f) => {
      const prop = tool.inputSchema.properties[f];
      const type = prop?.type ?? 'string';
      return `  ${f}: ${type}${prop?.description ? ` — ${prop.description}` : ''}`;
    })
    .join('\n');

  return (
    `Error: tool "${tool.name}" is missing required parameter(s): ${missing.join(', ')}.\n` +
    `Expected parameters:\n${schemaHint}\n` +
    `Please retry with all required parameters.`
  );
}

/**
 * Run a locally-registered tool. Mirrors `registry.ts`'s
 * `ToolRegistry.execute` (validate → try/catch `execute()` → error string
 * on throw) + `executeAnyTool`'s string-result truncation, for exactly the
 * slice this covers (no permission/approval/policy checks — see the module
 * doc's "Known gap"; none of today's registered tools need them).
 *
 * Never throws for a normal tool-level error (validation failure, or an
 * `Error` thrown inside the tool's own `execute()`, e.g. `show_widget`'s
 * deliberate validation throws) — those become an error-string `ToolResult`
 * here, exactly like the reverse path would produce via
 * `registry.ts:ToolRegistry.execute`'s own try/catch. This function DOES
 * still let a genuinely unexpected exception propagate (e.g. a bug in this
 * dispatch layer, or `getSettingsReader()` reaching its throwing default
 * because `setSettingsReader` was never wired) — that's the caller's
 * (`agentLoopHost.ts`) signal to fall back to the reverse `tool.invoke`
 * path, per this module's `readOnly` discipline. `LocalToolUnsupportedError`
 * (P1-3d-4, thrown only by `readFileLocalTool`'s wrapper today — see its
 * doc) is deliberately RE-THROWN rather than stringified, for the exact
 * same reason: it's this dispatch layer's own signal to escalate, not a
 * tool-level result to hand back to the model.
 */
export async function executeLocalTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
  contextUsagePercent: number | undefined,
): Promise<ToolResult> {
  const entry = LOCAL_TOOLS.get(name);
  if (!entry) {
    throw new Error(`[sidecar] executeLocalTool called for unregistered tool "${name}" — caller must check hasLocalTool() first.`);
  }

  const validationError = validateRequiredFields(entry.tool, input);
  if (validationError) return validationError;

  let result: ToolResult;
  try {
    result = await entry.tool.execute(input, context);
  } catch (err) {
    if (err instanceof LocalToolUnsupportedError) throw err;
    // Parity with the reverse path: there, a thrown error is stringified by
    // toolRegistry.execute and THEN guided by executeAnyTool. Today's file
    // tools catch internally and return an error string (guided below), so
    // this branch is only hit by an unexpected throw — but guide it too so an
    // OS-permission error surfaces identically whether thrown or returned.
    return applyOSPermissionGuideIfNeeded(
      name,
      `Error executing tool "${name}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof result === 'string') {
    // Parity with executeAnyTool (registry.ts): a locally-executed file tool
    // that fails with an OS-permission error gets the same friendly grant-guide
    // instead of a raw EACCES string. Closes the OS-permission-guide gap
    // documented in this module's header. Not truncated when guided (the raw
    // error is short) — matches the reverse path exactly.
    const guided = applyOSPermissionGuideIfNeeded(name, result);
    if (guided !== result) return guided;
    return truncateToolResult(name, result, contextUsagePercent);
  }
  return result;
}
