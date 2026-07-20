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
 *     `find_files` — P1-3d-4): see that section's own doc block below for
 *     the FULL bundle-feasibility trace (it needed THREE new shims this
 *     batch adds, not zero — `fsBridge.ts`/`defaultWorkspace.ts`/
 *     `aiEditSnapshots.ts`, plus two bare-package additions,
 *     `@tauri-apps/plugin-os` and `@tauri-apps/plugin-fs`'s `lstat` — this
 *     summary line is not the full story, read the block below it).
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
 * equivalent is `toolInvoker.getAllTools()` (already reverse-backed via
 * `tool.list`, see `agentLoopHost.ts`'s `createReverseToolInvoker`) — but
 * adapting `toolSearchTool.ts` to take a tools list instead of importing
 * `getAllTools()` directly is a real (if small) behavior change to a
 * module shared with the shell-side call path, not pure glue. Left for a
 * follow-up batch rather than done as a side effect of this one.
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
 * `fileTools.ts` exports SEVEN tools from one file; only FOUR are registered
 * below (read/list/search/find — NOT write/edit/delete, per this batch's
 * scope). Because ES module semantics evaluate every top-level import in a
 * file regardless of which exports are actually used, importing ANY of
 * `fileTools.ts`'s exports drags in ALL of its top-level imports — including
 * ones only `writeFileTool`/`editFileTool`/`deleteFileTool` need. Verified
 * empirically (`npm run build:sidecar` against a probe import), not assumed:
 * this required THREE new bundle-graph fixes beyond what P1-3d-1 needed —
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
 *      directly — forbidden. New THROWING shim `shims/defaultWorkspaceRun.ts`
 *      (write_file is not locally-executed, so this is provably dead here).
 *   3. `utils/aiEditSnapshots.ts` — same shape, imported ONLY for
 *      `writeFileTool`/`editFileTool`'s `snapshotBeforeAiEdit`, pulls
 *      `useChatStore`. New THROWING shim `shims/aiEditSnapshotsRun.ts`.
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
 */
import type { ToolDefinition, ToolResult, ToolExecutionContext } from '@/types';
import { showWidgetTool, readMeTool } from '@/core/tools/definitions/widgetTools';
import { httpFetchTool, webSearchTool } from '@/core/tools/definitions/webTools';
import {
  readFileTool,
  listDirectoryTool,
  searchFilesTool,
  findFilesTool,
} from '@/core/tools/definitions/fileTools';
import { getFileExtension, ARCHIVE_EXTENSIONS } from '@/core/tools/helpers/toolHelpers';
import { isWindows } from '@/utils/platform';
import { truncateToolResult } from '@/core/context/truncation';

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

const LOCAL_TOOLS = new Map<string, LocalToolEntry>(
  (
    [
      showWidgetTool,
      readMeTool,
      httpFetchTool,
      webSearchTool,
      readFileLocalTool,
      listDirectoryTool,
      searchFilesTool,
      findFilesTool,
    ] as ToolDefinition[]
  ).map((tool) => [tool.name, { tool, readOnly: true }]),
);

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
    return `Error executing tool "${name}": ${err instanceof Error ? err.message : String(err)}`;
  }

  if (typeof result === 'string') {
    return truncateToolResult(name, result, contextUsagePercent);
  }
  return result;
}
