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
 * ── Known gap (flagged, not silently swallowed) ──────────────────────────
 * `registry.ts`'s `executeAnyTool` runs an enterprise-policy pre-check
 * (`getCurrentPolicy()`/`checkTool()`, `registry.ts:389-405`) against EVERY
 * tool, including read-only ones, before invoking `execute()`.
 * `getCurrentPolicy()` reads `useEnterpriseStore` (`@/stores/enterpriseStore`),
 * which `bundleGraphGuardPlugin` permanently forbids from the sidecar
 * bundle. Locally-executed tools below therefore SKIP that policy
 * pre-check — a real behavior difference from the reverse path. This is
 * in scope for the design doc's §3 `approval.check` reverse channel
 * (3d-3+), not this batch: 3d-1 is explicitly scoped to the zero-approval
 * Tier A slice (design doc §2), so this gap applies to exactly the tools
 * registered here and no wider.
 */
import type { ToolDefinition, ToolResult, ToolExecutionContext } from '@/types';
import { showWidgetTool, readMeTool } from '@/core/tools/definitions/widgetTools';
import { httpFetchTool, webSearchTool } from '@/core/tools/definitions/webTools';
import { truncateToolResult } from '@/core/context/truncation';

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
  ([showWidgetTool, readMeTool, httpFetchTool, webSearchTool] as ToolDefinition[]).map((tool) => [
    tool.name,
    { tool, readOnly: true },
  ]),
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
 * path, per this module's `readOnly` discipline.
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
    return `Error executing tool "${name}": ${err instanceof Error ? err.message : String(err)}`;
  }

  if (typeof result === 'string') {
    return truncateToolResult(name, result, contextUsagePercent);
  }
  return result;
}
