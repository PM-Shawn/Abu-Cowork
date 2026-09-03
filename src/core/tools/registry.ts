import type { ToolDefinition, ToolResult, ToolExecutionContext } from '../../types';
import { mcpManager } from '../mcp/client';
import { parseNamespacedToolName } from '../mcp/toolName';
import { analyzeCommand, type ConfirmationInfo, type DangerLevel } from './commandSafety';
import {
  checkReadPath,
  checkWritePath,
  checkListPath,
  authorizeWorkspace,
  scopedAuthorizeWorkspace,
  hasFullShellAuthorizationScope,
  isInScopedAuthorizedWorkspace,
  type AuthorizationScopeId,
} from './pathSafety';
import { getI18n } from '../../i18n';
import { truncateToolResult } from '../context/truncation';
import { getSettingsReader } from '../agent/ports/settingsReader';
import { useChatStore } from '../../stores/chatStore';
import { getPermissionStrategy } from '../permissions/permissionMode';
import {
  browserToolTargetsPage,
  classifyBrowserTool,
  decideBrowserOperation,
  grantBrowserAutomation,
  hasBrowserGrant,
  getSiteVerdict,
  isScriptingBrowserTool,
  normalizeBrowserOrigin,
  toLegacyBrowserToolConsequence,
  DEFAULT_BROWSER_OPERATION_POLICY,
  type BrowserDenialReasonCode,
  type DecideBrowserOperationSiteVerdict,
} from '../permissions/browserToolPolicy';
import { isHighRiskUrl } from '../permissions/highRiskSites';
import {
  notifyUnattendedDenial,
  resolveUnattendedConfirmation,
} from '../permissions/unattendedConfirmation';
import { deriveRunInteractionMode } from '../agent/runInteractionMode';
import { classifySelfExtension } from '../permissions/selfExtensionPolicy';
import {
  analyzeCommandBoundary,
  resolveFullNoWorkspaceCommandWriteTargets,
  type CmdBoundary,
} from '../permissions/commandBoundary';
import { commandWritableDirectories, isInsideWorkingDirs } from '../permissions/workingDirs';
import { reviewAction } from '../safety/reviewer';
import { getLoopContext } from '../agent/permissionBridge';
import { homeDir } from '@tauri-apps/api/path';
import { TOOL_NAMES } from './toolNames';
import { applyOSPermissionGuideIfNeeded } from './osPermissionGuide';
import { isLabsFlagOn } from '../labs/resolve';
import { LABS_TODOS_INBOX } from '../labs/registry';
import {
  decideCommandUnderRunPermissionCeiling,
  decideFileUnderRunPermissionCeiling,
  decideStateChangingToolUnderRunPermissionCeiling,
  decideToolUnderRunPermissionCeiling,
  getRunPermissionCeilingFromContext,
} from '../permissions/runPermissionCeiling';
import { getLargeWriteBlockReason } from '../agent/hooks/largeWriteGuard';
import {
  browserChannelForTool,
  buildBrowserSignalContext,
  buildBrowserSignalRecord,
  classifyBlockedPage,
  classifyBrowserToolError,
  deriveTargetKey,
  detectFrameHint,
  getCachedTabOrigin,
  isBrowserToolResultError,
  noteBrowserToolOutcome,
  noteTabOrigin,
  safeRecordBrowserSignal,
} from '../observability/browserSignals';
import { toolResultToString as browserSignalToolResultToString } from './toolResultToString';

/**
 * Builtin tools whose availability is gated on a Labs experiment. A gated-off
 * tool must be neither advertised (getAllTools) nor executable (executeAnyTool)
 * — the two checks below keep parity so toggling the flag off fully retracts
 * the tool, matching the old compile-time gate's fail-safe (the tool stays
 * registered, so this map is the single source of truth for "is it live").
 */
const LABS_GATED_TOOLS: Record<string, string> = {
  [TOOL_NAMES.CREATE_TODO]: LABS_TODOS_INBOX,
};

/** Exported so capabilitySnapshot.ts (see `getAllTools` doc above) can report
 *  the real gate decision instead of re-deriving it from a second copy of
 *  `LABS_GATED_TOOLS`. */
export function isToolGatedOff(name: string): boolean {
  const experimentId = LABS_GATED_TOOLS[name];
  return experimentId !== undefined && !isLabsFlagOn(experimentId);
}

/** The Labs experiment id gating `name`, or undefined if `name` isn't
 *  Labs-gated at all. Single source of truth alongside `isToolGatedOff` —
 *  used by capabilitySnapshot.ts to explain *why* a tool is gated off. */
export function getToolLabsGateId(name: string): string | undefined {
  return LABS_GATED_TOOLS[name];
}
import { getCurrentPolicy } from '@/core/enterprise/policy/enforcer';
import { checkTool } from '@/core/enterprise/policy/matcher';
import { showPolicyConfirm } from '@/components/enterprise/policyConfirmQueue';

// Cache home dir for command-boundary resolution (only resolved on first safe write command).
let cachedHomeDir: string | null = null;
async function getCachedHomeDir(): Promise<string> {
  if (cachedHomeDir === null) cachedHomeDir = await homeDir();
  return cachedHomeDir;
}

/**
 * Extract text-only representation from a ToolResult. Relocated to
 * `./toolResultToString` (P1-3B-3A item 2, a zero-import leaf module so the
 * sidecar's `ToolInvoker` shims can use the REAL implementation without
 * dragging this whole file's store/mcp/enterprise graph); re-exported here
 * for existing callers.
 */
export { toolResultToString } from './toolResultToString';

/**
 * Check if a ToolResult contains image content.
 */
export function toolResultHasImages(result: ToolResult): boolean {
  if (typeof result === 'string') return false;
  return result.some((c) => c.type === 'image');
}

/**
 * Validate tool input against its schema's required fields.
 * Only checks for missing/null/undefined — does NOT over-validate types
 * (LLMs may pass numbers as strings, etc., and that's usually fine).
 * Returns an error string if validation fails, null if OK.
 */
function validateToolInput(tool: ToolDefinition, input: Record<string, unknown>): string | null {
  // Detect tool call args that failed to parse as JSON. Note: when the LLM
  // hits max_tokens mid tool-call (finish_reason='length'), the openai-compatible
  // adapter now drops broken tool calls and signals stopReason='max_tokens' so
  // the agent loop's escalation can retry — that path no longer reaches here.
  // This branch covers the remaining cases: model genuinely produced invalid JSON.
  if ('_parse_error' in input) {
    const requiredFields = tool.inputSchema.required ?? [];
    const requiredHint = requiredFields.length > 0
      ? `\n该工具的必填参数：${requiredFields.join(', ')}`
      : '';
    return `Error: 工具 "${tool.name}" 的调用参数不是合法 JSON，无法解析。` +
      requiredHint +
      `\n请重新调用该工具，arguments 字段必须是严格序列化的 JSON 字符串。` +
      `如果连续多次失败，可能是模型本轮输出已达上限。`;
  }

  const required = tool.inputSchema.required;
  if (!required || required.length === 0) return null;

  const missing: string[] = [];
  for (const field of required) {
    if (input[field] === undefined || input[field] === null) {
      missing.push(field);
    }
  }

  if (missing.length === 0) return null;

  // Build actionable error message with expected schema
  const schemaHint = required.map(f => {
    const prop = tool.inputSchema.properties[f];
    const type = prop?.type ?? 'string';
    return `  ${f}: ${type}${prop?.description ? ` — ${prop.description}` : ''}`;
  }).join('\n');

  return `Error: tool "${tool.name}" is missing required parameter(s): ${missing.join(', ')}.\n` +
    `Expected parameters:\n${schemaHint}\n` +
    `Please retry with all required parameters.`;
}

class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  remove(name: string): void {
    this.tools.delete(name);
  }

  async execute(name: string, input: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: Unknown tool "${name}"`;
    }

    // Validate required parameters before execution
    const validationError = validateToolInput(tool, input);
    if (validationError) {
      return validationError;
    }

    try {
      return await tool.execute(input, context);
    } catch (err) {
      return `Error executing tool "${name}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export const toolRegistry = new ToolRegistry();

/**
 * Playwright browser tools that overlap with Abu's in-app browser or Chrome bridge.
 * When either Abu browser runtime is connected, these are filtered out to avoid
 * the LLM accidentally launching a separate Chromium instance.
 *
 * Exported so capabilitySnapshot.ts can report the real "filtered as duplicate"
 * reason instead of re-typing this list.
 */
export const PLAYWRIGHT_BROWSER_TOOLS = new Set([
  'playwright__browser_tabs',
  'playwright__browser_tab_open',
  'playwright__browser_navigate',
  'playwright__browser_click',
  'playwright__browser_type',
  'playwright__browser_select_option',
  'playwright__browser_take_screenshot',
  'playwright__browser_snapshot',
  'playwright__browser_run_code',
  'playwright__browser_wait_for',
  'playwright__browser_tab_close',
  'playwright__browser_press_key',
  'playwright__browser_scroll',
  'playwright__browser_drag',
  'playwright__browser_hover',
  'playwright__browser_handle_dialog',
  'playwright__browser_file_upload',
]);

/**
 * Get all available tools: builtin tools + MCP tools
 * Deduplicates by tool name — builtin tools take priority over MCP tools
 * Filters out conflicting playwright browser tools when an Abu browser is connected
 */
export function getAllTools(): ToolDefinition[] {
  const builtinTools = toolRegistry.getAll();
  const mcpTools = mcpManager.listTools();
  const toolMap = new Map<string, ToolDefinition>();

  const hasAbuBrowser =
    mcpManager.isConnected('abu-browser') ||
    mcpManager.isConnected('abu-browser-bridge');

  // Computer use tools are always registered — the tool itself handles
  // auto-enabling and permission checks when first called.

  // Builtin tools first (higher priority). Labs-gated tools whose experiment
  // is off are withheld from the advertised schema (see LABS_GATED_TOOLS).
  for (const tool of builtinTools) {
    if (isToolGatedOff(tool.name)) continue;
    toolMap.set(tool.name, tool);
  }
  // MCP tools — only add if no name conflict
  for (const tool of mcpTools) {
    if (!toolMap.has(tool.name)) {
      // Skip Playwright browser tools when an Abu-owned browser path is active.
      if (hasAbuBrowser && PLAYWRIGHT_BROWSER_TOOLS.has(tool.name)) {
        continue;
      }
      toolMap.set(tool.name, tool);
    }
  }
  return Array.from(toolMap.values());
}

/**
 * Callback type for command confirmation.
 *
 * `loopId` is not optional in practice — it is how the request is stamped with
 * the conversation that owns it. Without it `requestCommandConfirmation` falls
 * back to `getCurrentLoopContext()`, which returns the FIRST entry of the
 * global loop map; with a second loop registered the dialog is tagged with the
 * wrong conversation, `ChatView` filters it out, and the run waits forever on
 * an approval nobody can see. Mirrors `FilePermissionCallback` below.
 */
export type CommandConfirmCallback = (info: ConfirmationInfo, loopId?: string) => Promise<boolean>;

/**
 * Callback type for file permission requests
 */
export type FilePermissionCallback = (request: {
  path: string;
  capability: 'read' | 'write';
  toolName: string;
}, loopId?: string) => Promise<boolean>;

/**
 * Map of file-related tools to their path extraction logic
 */
// Use a definedness/type check, NOT a truthy check: an empty-string path is
// "present but invalid" and must still flow THROUGH the boundary check (which
// rejects it), not skip it. A truthy `i.path ?` treats '' as falsy → returns
// null → the whole permission/boundary block is bypassed for path: ''.
export const FILE_TOOL_PATH_MAP: Record<string, (input: Record<string, unknown>) => { path: string; capability: 'read' | 'write' } | null> = {
  [TOOL_NAMES.READ_FILE]:      (i) => typeof i.path === 'string' ? { path: i.path, capability: 'read' } : null,
  [TOOL_NAMES.LIST_DIRECTORY]: (i) => typeof i.path === 'string' ? { path: i.path, capability: 'read' } : null,
  [TOOL_NAMES.WRITE_FILE]:     (i) => typeof i.path === 'string' ? { path: i.path, capability: 'write' } : null,
  [TOOL_NAMES.EDIT_FILE]:      (i) => typeof i.path === 'string' ? { path: i.path, capability: 'write' } : null,
  [TOOL_NAMES.DELETE_FILE]:    (i) => typeof i.path === 'string' ? { path: i.path, capability: 'write' } : null,
  [TOOL_NAMES.SEARCH_FILES]:   (i) => typeof i.path === 'string' ? { path: i.path, capability: 'read' } : null,
  [TOOL_NAMES.FIND_FILES]:     (i) => typeof i.path === 'string' ? { path: i.path, capability: 'read' } : null,
  // Uploading is a read of local data. It must pass the same path/scope gate as
  // read_file before any IM network side effect occurs.
  [TOOL_NAMES.SEND_FILE]:      (i) => typeof i.path === 'string' ? { path: i.path, capability: 'read' } : null,
};

/**
 * Result of {@link checkToolApproval} — the single source of truth for
 * "is this tool call allowed to execute". `reason` on a `'deny'` decision is
 * the EXACT `ToolResult` error string `executeAnyTool` used to return
 * directly before this function was extracted (P1-3d-3) — callers that
 * short-circuit on `'deny'` return `reason` verbatim to preserve behavior.
 */
/**
 * What the browser gate learned at APPROVAL time and the executor must carry
 * down to the browser host — the fix for the TOCTOU gap U5 closes.
 *
 * The gate resolves which page an action targets, then approves it. Between
 * that approval and the action landing, the page can move: a server redirect,
 * `window.location`, a meta refresh. Until now nothing rechecked, so a click
 * approved for `https://shop.example.com` could execute on whatever the tab
 * had drifted to. `expectedOrigin` travels with the call (over `_meta`, never
 * the model-visible tool schema) so the host can compare it against the view's
 * actual URL immediately before acting.
 *
 * `runMode` rides along because the host's enforcement is scoped to unattended
 * runs (attended keeps its exact shipped behavior — a human is watching the
 * page move), and because `get_downloads` filtering needs it shell-side.
 */
export interface BrowserExecutionPin {
  runMode: 'attended' | 'unattended';
  /**
   * The origin the gate approved. Absent when the action targets no resolvable
   * page (`get_tabs`, `connection_status`, `get_downloads`, a history
   * navigation) — which for an UNATTENDED state-changing action is itself a
   * refusal at the host, since the gate never lets one of those through.
   */
  expectedOrigin?: string;
  /**
   * U6 / F2.4 — the gate saw `authState: 'login_required'` for this action's
   * tab. Set only when true, and consumed SHELL-SIDE (an unattended run never
   * gets here — it was already refused), so an attended result can carry the
   * "sign in first" note the model needs. It is deliberately NOT forwarded to
   * the host: the host is where the fact came from, and re-sending it would
   * make a page-observable field look like an instruction to the host.
   */
  loginRequired?: true;
}

export interface ToolApprovalDecision {
  decision: 'allow' | 'deny';
  reason?: string;
  /** Canonical file path that the executor must use for an approved file tool. */
  executionPath?: string;
  /** Browser-only: approval-time facts the executor must carry to the host. */
  browserExecution?: BrowserExecutionPin;
}

/**
 * The full tool-call approval chain (P1-3d-3,
 * docs/2026-07-21-phase1-p3d-tool-migration-design.md §3): command safety
 * analysis (+ optional AI review + user confirmation), file-path permission
 * checks (`FILE_TOOL_PATH_MAP` → pathSafety, + optional AI review + user
 * permission prompt), and the enterprise policy pre-check — in that exact
 * order. This is a SURGICAL EXTRACTION of what used to be the first half of
 * `executeAnyTool`'s body (behavior-preserving refactor, no logic changed —
 * see `toolRegistry.integration.test.ts` for the regression coverage this
 * relies on). `executeAnyTool` calls this first and only proceeds to
 * `execute()` on `'allow'`.
 *
 * This is also the SINGLE SOURCE OF TRUTH the sidecar's `approval.check`
 * reverse-RPC handler (`agentLoopRunner.ts`'s `handleApprovalCheck`) calls
 * for tools the sidecar wants to run locally — never duplicate this chain,
 * always call through here (fail-closed: an approval decision made anywhere
 * else risks drifting from this one and silently reopening the exact policy
 * gap P1-3d-1 flagged).
 *
 * Every UI-facing callback (`onRequireConfirmation`/`onRequireFilePermission`)
 * and every side-effecting call (`authorizeWorkspace`, `showPolicyConfirm`)
 * stays exactly as it was — this function still runs shell-side only.
 */
/**
 * Resolve which page a browser action targets: both the exact `origin` (the
 * key every site verdict is stored under) and the FULL `url`.
 *
 * The full URL is what `highRiskSites.ts` needs — `/transfer`, `/checkout`
 * and their kin live in the path, which an origin throws away — and it is
 * deliberately kept alongside the origin rather than replacing it, so the
 * site-verdict lookup keeps its exact pre-U5 key.
 *
 * `navigate` carries the destination in its input; every other action only
 * carries a `tabId`, so we ask the same browser server for its tab list
 * (`get_tabs` returns each tab's URL) and match the id. Best-effort: any
 * failure resolves to nulls, which the gate treats as "unknown site" — the
 * action can still be approved, but only one conversation at a time, never
 * persistently.
 *
 * The same listing also carries `authState` (U6 / F2.4) when the browser host
 * has seen that origin ask for a login, so the login-expiry check costs no
 * extra round trip. A `navigate` resolves no `authState`: its destination has
 * not been visited yet, and the flag is about where a tab IS.
 */
interface BrowserActionTarget {
  origin: string | null;
  url: string | null;
  /**
   * `'login_required'` when the host flagged this tab's origin. ADVISORY: read
   * only on the deny side of the gate (see the U6 block below). A page cannot
   * author it — the built-in host derives it from HTTP status and navigation
   * URL, and the extension channel reports no `authState` at all — but even if
   * one could, widening is structurally impossible: nothing downstream turns
   * this value into an allow.
   */
  authState: 'login_required' | null;
}

/** Only the one value the gate acts on; anything else is treated as absent. */
function parseTabAuthState(value: unknown): 'login_required' | null {
  return value === 'login_required' ? 'login_required' : null;
}

async function resolveBrowserActionTarget(
  namespacedName: string,
  input: Record<string, unknown>,
  conversationId?: string,
  agentRunId?: string,
): Promise<BrowserActionTarget> {
  // Same shared parse as the gate that called us and the dispatcher that will
  // run this (U9 / C1) — never a second, local split. Callers only reach here
  // for a name `classifyBrowserTool` already accepted, so the null branch is
  // unreachable defense: an unresolvable target is "unknown origin", which
  // asks (attended) or refuses (unattended).
  const parsed = parseNamespacedToolName(namespacedName);
  if (parsed === null) return { origin: null, url: null, authState: null };
  const { serverName, toolName } = parsed;

  if (toolName === 'navigate') {
    // Only `goto` actually navigates to `input.url`. For back/forward/reload
    // the executor ignores `url` entirely, so trusting it here would let a
    // decoy url ride an allowed-site verdict while the browser goes somewhere
    // else (history/reload). Destination is unknowable → null → ask.
    const action = typeof input.action === 'string' ? input.action : 'goto';
    if (action !== 'goto') return { origin: null, url: null, authState: null };
    const url = typeof input.url === 'string' ? input.url : undefined;
    const origin = url ? normalizeBrowserOrigin(url) : null;
    // The url is reported only when it resolved to a real http(s) origin, so a
    // `javascript:`/`about:` string never reaches the high-risk classifier as
    // if it were a page address.
    return { origin, url: origin !== null ? (url ?? null) : null, authState: null };
  }

  const tabId = Number(input.tabId);
  if (!Number.isFinite(tabId)) return { origin: null, url: null, authState: null };
  try {
    // Approval must never hang on a wedged browser server: the MCP browser
    // timeout is 120s, so race a short deadline and fall back to "unknown
    // origin" (which just asks).
    //
    // The conversation id is REQUIRED here, not optional: every agent tab is
    // owned by the conversation that opened it, and a caller that sends none
    // is a legacy caller that can only see legacy tabs. Without it the gate
    // resolves null for every owned tab — the site the user explicitly
    // blocked stops being denied, persistent site grants stop applying, and
    // unattended runs deny everything.
    //
    // `createIfEmpty: false` keeps this probe read-only: the host's get_tabs
    // provisions an automation view when the caller owns none, and a *gate*
    // query must never be the thing that opens a tab (the action it is gating
    // may well be denied).
    const result = await Promise.race([
      mcpManager.callTool(serverName, 'get_tabs', {}, {
        conversationId,
        // The run id is as REQUIRED as the conversation id, and for the same
        // reason: the host owns tabs by the pair, so a probe that sent only the
        // conversation would list the MAIN loop's tabs and resolve null for
        // every tab a subagent opened — silently re-opening the exact fail-open
        // (blocked sites stop being denied, unattended runs deny everything)
        // that threading the conversation id closed.
        agentRunId,
        createBrowserTabIfEmpty: false,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (result === null || typeof result !== 'string') return { origin: null, url: null, authState: null };
    const parsed = JSON.parse(result) as {
      windows?: Array<{ tabs?: Array<{ tabId?: number; url?: string; authState?: unknown }> }>;
    };
    for (const win of parsed.windows ?? []) {
      for (const tab of win.tabs ?? []) {
        if (tab.tabId !== tabId) continue;
        const origin = normalizeBrowserOrigin(tab.url);
        return {
          origin,
          url: origin !== null ? (tab.url ?? null) : null,
          authState: parseTabAuthState(tab.authState),
        };
      }
    }
    return { origin: null, url: null, authState: null };
  } catch {
    return { origin: null, url: null, authState: null };
  }
}

/**
 * Records the tool_call signal (+ any derived fallback_to_script/
 * repeat_action/blocked_page signals) for one browser MCP tool invocation,
 * at the execution boundary in `executeAnyTool` — after the approval gate,
 * around the actual `mcpManager.callTool` call. Never throws: every
 * `safeRecordBrowserSignal` call already swallows its own errors, and this
 * function performs no I/O of its own.
 *
 * `origin` is best-effort and NEVER does its own `get_tabs` round trip
 * (unlike `resolveBrowserActionOrigin` above, which the approval gate can
 * afford once per state-changing call) — resolving a bare `tabId` to an
 * origin for every read-only call too would double this app's browser
 * traffic just for telemetry. Instead: a successful `navigate` resolves its
 * own origin for free (its `url` input is right there), which is cached by
 * tabId (`noteTabOrigin`) so every LATER call against that same tab —
 * click, fill, extract_text, ... — can reuse it via `getCachedTabOrigin`
 * with zero additional round trips, giving `bySiteAndPlatform` real
 * per-site coverage beyond navigate calls alone.
 *
 * `frameHint`/`blockedClass` are only computed when the call FAILED (`!ok`):
 * a SUCCESSFUL result's content can legitimately contain "iframe" (a
 * snapshot's DOM tree), "429" (a price/item count), or "cloudflare" (a page
 * footer) without any of that meaning the page blocked the agent — see
 * `browserSignals.ts`'s `classifyBlockedPage`/`detectFrameHint` docs.
 */
function recordBrowserToolCallSignal(
  namespacedName: string,
  toolContext: ToolExecutionContext | undefined,
  input: Record<string, unknown>,
  startedAt: number,
  resultText: string,
): void {
  // Shared parse (U9 / C1). A name that does not round-trip never reaches
  // execution, so the fallback here is only for a bare builtin-shaped name.
  const bareToolName = parseNamespacedToolName(namespacedName)?.toolName ?? namespacedName;
  const durationMs = Date.now() - startedAt;
  const ok = !isBrowserToolResultError(resultText);
  const conversationId = toolContext?.conversationId;
  const targetKey = deriveTargetKey(bareToolName, input);
  const { repeat, fallback } = noteBrowserToolOutcome(conversationId, bareToolName, targetKey, ok);

  const tabIdRaw = input.tabId;
  const tabId = typeof tabIdRaw === 'number'
    ? tabIdRaw
    : typeof tabIdRaw === 'string' && tabIdRaw.trim() !== '' && Number.isFinite(Number(tabIdRaw))
      ? Number(tabIdRaw)
      : undefined;

  let origin: string | undefined;
  if (bareToolName === 'navigate' && typeof input.url === 'string') {
    origin = normalizeBrowserOrigin(input.url) ?? undefined;
    if (ok && origin && tabId !== undefined) noteTabOrigin(conversationId, tabId, origin);
  } else if (tabId !== undefined) {
    origin = getCachedTabOrigin(conversationId, tabId);
  }

  const context = buildBrowserSignalContext(
    browserChannelForTool(namespacedName) ?? 'builtin',
    conversationId,
    Date.now(),
    toolContext?.loopId,
  );
  safeRecordBrowserSignal(() => buildBrowserSignalRecord(
    {
      kind: 'tool_call',
      tool: namespacedName,
      ok,
      durationMs,
      ...(tabId !== undefined ? { tabId } : {}),
      ...(origin ? { origin } : {}),
      ...(!ok && detectFrameHint(resultText) ? { frameHint: true as const } : {}),
      ...(ok ? {} : { errorClass: classifyBrowserToolError(resultText) ?? 'unknown_error' }),
    },
    context,
  ));

  if (fallback) {
    safeRecordBrowserSignal(() => buildBrowserSignalRecord({ kind: 'fallback_to_script' }, context));
  }
  if (repeat.shouldEmit) {
    safeRecordBrowserSignal(() => buildBrowserSignalRecord(
      { kind: 'repeat_action', tool: bareToolName, targetKey, count: repeat.count },
      context,
    ));
  }
  if (!ok) {
    const blockedClass = classifyBlockedPage(resultText);
    if (blockedClass) {
      safeRecordBrowserSignal(() => buildBrowserSignalRecord({ kind: 'blocked_page', className: blockedClass }, context));
    }
  }
}

/**
 * Why a scoped (unattended) run's non-read-only command was refused, so the
 * denial the model reads says what to change instead of just "no".
 *
 * `no-cwd` is the notable case: standard/smart runs fail closed and get an
 * actionable remedy. A trusted full/autonomous scope receives the one narrow
 * exception requested by the product decision; the distinct return value
 * below keeps its hard-floor preflight from affecting scoped runs that do
 * have a workspace.
 */
type ScopedCwdDecision = 'full-no-cwd' | 'no-cwd' | 'not-writable' | null;

async function scopedCommandCwdDenial(
  input: Record<string, unknown>,
  toolContext?: ToolExecutionContext,
): Promise<ScopedCwdDecision> {
  const scopeId = toolContext?.authorizationScopeId;
  if (scopeId === undefined) return null;
  const effectiveCwd = typeof input.cwd === 'string' && input.cwd.trim().length > 0
    ? input.cwd
    : toolContext?.workspacePath ?? undefined;
  if (!effectiveCwd) {
    return hasFullShellAuthorizationScope(scopeId) ? 'full-no-cwd' : 'no-cwd';
  }
  if (!isInsideWorkingDirs(effectiveCwd, commandWritableDirectories(scopeId))) {
    return 'not-writable';
  }
  return (await checkWritePath(effectiveCwd, scopeId)).allowed ? null : 'not-writable';
}

async function fullNoWorkspaceCommandTargetDenial(
  command: string,
  cwd: string | undefined,
  scopeId: string | undefined,
): Promise<string | null> {
  if (!hasFullShellAuthorizationScope(scopeId)) return null;
  const targets = resolveFullNoWorkspaceCommandWriteTargets(
    command,
    cwd,
    await getCachedHomeDir(),
  );

  for (const target of targets) {
    const check = await checkWritePath(target, scopeId);
    // Autonomous approval is not a persistent path grant. Dialog-eligible
    // targets continue to the command sandbox with an empty scoped map; hard
    // blocks are the only path decisions enforced here.
    if (check.allowed || check.needsPermission) continue;
    return `Error: ${check.reason || getI18n().toolErrors.pathAccessDenied}`;
  }

  return null;
}

export async function checkToolApproval(
  name: string,
  input: Record<string, unknown>,
  toolContext?: ToolExecutionContext,
  onRequireConfirmation?: CommandConfirmCallback,
  onRequireFilePermission?: FilePermissionCallback,
): Promise<ToolApprovalDecision> {
  const t = getI18n();
  const conversation = toolContext?.conversationId
    ? useChatStore.getState().conversations[toolContext.conversationId]
    : undefined;
  const convPermissionMode = conversation?.permissionMode;
  const permissionMode = convPermissionMode ?? getSettingsReader().getSnapshot().permissionMode;
  const strategy = getPermissionStrategy(permissionMode);
  const runPermissionCeiling = getRunPermissionCeilingFromContext(toolContext);
  const toolCeilingDecision = decideToolUnderRunPermissionCeiling(runPermissionCeiling, name, input);
  if (toolCeilingDecision.decision === 'deny') {
    return toolCeilingDecision;
  }
  // A background command returns after spawn, not after the OS child exits.
  // Scoped unattended runs must not release their authorization scope while
  // such a child can still be alive; abort_command is best-effort and has no
  // join contract. Keep foreground chat behavior unchanged and fail closed at
  // the shared approval boundary for every scoped execution venue.
  if (
    name === TOOL_NAMES.RUN_COMMAND
    && input.background !== undefined
    && input.background !== false
    && toolContext?.authorizationScopeId !== undefined
  ) {
    return {
      decision: 'deny',
      reason: 'Error: background commands are not allowed in scoped unattended runs',
    };
  }
  let largeWritePathAfterApproval: string | null = null;
  let approvedExecutionPath: string | undefined;
  /** Carried out of the browser block to the executor — see `BrowserExecutionPin`. */
  let browserExecutionPin: BrowserExecutionPin | undefined;

  // Safety check for run_command tool
  if (name === TOOL_NAMES.RUN_COMMAND) {
    const command = input.command as string;
    if (command) {
      const analysis = analyzeCommand(command);

      // Block dangerous commands — always enforced regardless of permission mode
      if (analysis.level === 'block') {
        return { decision: 'deny', reason: `Error: ${t.commandConfirm.blocked}: ${analysis.reason}` };
      }

      if (!analysis.readOnly) {
        const cwdDecision = await scopedCommandCwdDenial(input, toolContext);
        if (cwdDecision === 'no-cwd') {
          return {
            decision: 'deny',
            reason: t.toolErrors.scopedRunNoWorkspaceCommand,
          };
        }
        if (cwdDecision === 'not-writable') {
          return {
            decision: 'deny',
            reason: 'Error: command working directory is not write-authorized for this scoped run',
          };
        }
        if (cwdDecision === 'full-no-cwd') {
          const targetDenial = await fullNoWorkspaceCommandTargetDenial(
            command,
            undefined,
            toolContext?.authorizationScopeId,
          );
          if (targetDenial) {
            return { decision: 'deny', reason: targetDenial };
          }
        }
      }

      // Best-effort boundary check: only matters for safe, non-read-only commands
      // (risky commands already gate on content; autonomous never gates). Detects
      // commands that write outside the working dirs (e.g. `cp secret ~/Desktop/x`).
      let boundary: CmdBoundary = 'unknown';
      if (
        !analysis.readOnly &&
        analysis.level === 'safe' &&
        (permissionMode !== 'autonomous' || runPermissionCeiling !== null)
      ) {
        const cwd = (input.cwd as string | undefined) || toolContext?.workspacePath || undefined;
        boundary = analyzeCommandBoundary(command, cwd, await getCachedHomeDir(), toolContext?.authorizationScopeId);
      }

      const commandCeilingDecision = decideCommandUnderRunPermissionCeiling(
        runPermissionCeiling,
        { command, level: analysis.level, reason: analysis.reason },
        analysis.readOnly,
        boundary,
      );
      if (commandCeilingDecision.decision === 'deny') {
        return commandCeilingDecision;
      }

      // Decide how this command is gated. 'review' (smart tier) routes to the AI reviewer.
      const decision = strategy.decideCommand(
        { command, level: analysis.level, reason: analysis.reason },
        analysis.readOnly,
        boundary,
      );
      let outcome: 'allow' | 'confirm' | 'deny' = decision === 'review' ? 'confirm' : decision;
      let reviewReason = '';
      if (decision === 'review') {
        const verdict = await reviewAction(
          {
            kind: 'command',
            detail: command,
            staticReason: analysis.reason || (boundary === 'outside' ? '写入工作区外' : ''),
            conversationId: toolContext?.conversationId,
          },
          toolContext?.loopId ? getLoopContext(toolContext.loopId)?.signal : undefined,
        );
        if (verdict.decision === 'deny') {
          return { decision: 'deny', reason: `${t.commandConfirm.aiDenied}: ${verdict.reason}` };
        }
        outcome = verdict.decision === 'allow' ? 'allow' : 'confirm';
        // Surface the reviewer's reasoning so an escalated confirm explains itself.
        reviewReason = verdict.reason;
      }
      if (outcome === 'confirm') {
        if (!onRequireConfirmation) {
          return {
            decision: 'deny',
            reason: 'Error: command confirmation is unavailable for this run',
          };
        }
        const confirmed = await onRequireConfirmation({
          command,
          level: analysis.level,
          reason: reviewReason || analysis.reason,
        }, toolContext?.loopId);
        if (!confirmed) {
          return { decision: 'deny', reason: t.commandConfirm.userCancelled };
        }
      }
    }
  }

  // File permission check for file-related tools
  const pathExtractor = FILE_TOOL_PATH_MAP[name];
  if (pathExtractor) {
    const pathInfo = pathExtractor(input);
    if (pathInfo) {
      // Use the appropriate check function based on capability
      const checkFn = pathInfo.capability === 'write'
        ? (candidate: string, id?: AuthorizationScopeId) => checkWritePath(
          candidate,
          id,
          { followFinalSymlink: name !== TOOL_NAMES.DELETE_FILE },
        )
        : (name === TOOL_NAMES.LIST_DIRECTORY ? checkListPath : checkReadPath);

      const scopeId = toolContext?.authorizationScopeId;
      const fileCeilingDecision = decideFileUnderRunPermissionCeiling(
        runPermissionCeiling,
        pathInfo.capability,
        isInScopedAuthorizedWorkspace(pathInfo.path, pathInfo.capability, scopeId),
      );
      if (fileCeilingDecision.decision === 'deny') {
        return fileCeilingDecision;
      }
      let pathCheck = await checkFn(pathInfo.path, scopeId);

      if (!pathCheck.allowed) {
        if (pathCheck.needsPermission && pathCheck.permissionPath) {
          // Decide gating based on permission mode.
          const cap = pathCheck.capability || pathInfo.capability;
          let fileDecision = strategy.decideFileAccess(cap, true);
          // smart tier → AI reviewer resolves to allow / confirm / deny.
          if (fileDecision === 'review') {
            const verdict = await reviewAction(
              {
                kind: cap === 'read' ? 'file-read' : 'file-write',
                detail: pathCheck.permissionPath,
                staticReason: '访问工作区外路径',
                conversationId: toolContext?.conversationId,
              },
              toolContext?.loopId ? getLoopContext(toolContext.loopId)?.signal : undefined,
            );
            if (verdict.decision === 'deny') {
              return { decision: 'deny', reason: `${t.commandConfirm.aiDenied}: ${verdict.reason}` };
            }
            fileDecision = verdict.decision === 'allow' ? 'allow' : 'confirm';
          }
          if (fileDecision === 'confirm') {
            // Needs user permission — ask via callback
            if (onRequireFilePermission) {
              const granted = await onRequireFilePermission({
                path: pathCheck.permissionPath,
                capability: cap,
                toolName: name,
              }, toolContext?.loopId);
              if (!granted) {
                return { decision: 'deny', reason: `[${t.toolErrors.userDeniedAccess} ${pathCheck.permissionPath}]` };
              }
              // Permission granted — re-check (should now pass since authorizeWorkspace was called)
              pathCheck = await checkFn(pathInfo.path, scopeId);
              if (!pathCheck.allowed) {
                return { decision: 'deny', reason: `Error: ${pathCheck.reason || t.toolErrors.pathAccessDenied}` };
              }
            } else {
              // No callback available (shouldn't happen in normal flow)
              return { decision: 'deny', reason: `Error: ${t.toolErrors.needsAuthorization} ${pathCheck.permissionPath}` };
            }
          } else {
            // allow → auto-authorize the workspace for this path
            if (scopeId !== undefined) {
              scopedAuthorizeWorkspace(scopeId, pathCheck.permissionPath, [cap]);
            } else {
              authorizeWorkspace(pathCheck.permissionPath, [cap]);
            }
            // Pin the target only after the newly-created grant has been
            // checked against the path as it exists now. An auto-grant must
            // not turn a retargeted symlink into an unchecked allow.
            pathCheck = await checkFn(pathInfo.path, scopeId);
            if (!pathCheck.allowed) {
              return { decision: 'deny', reason: `Error: ${pathCheck.reason || t.toolErrors.pathAccessDenied}` };
            }
          }
        } else {
          // Hard blocked — always enforced regardless of permission mode
          return { decision: 'deny', reason: `Error: ${pathCheck.reason}` };
        }
      }

      if (!pathCheck.allowed || !pathCheck.resolvedPath) {
        return {
          decision: 'deny',
          reason: `Error: ${pathCheck.reason || t.toolErrors.pathAccessDenied}`,
        };
      }
      approvedExecutionPath = pathCheck.resolvedPath;

      if (name === TOOL_NAMES.WRITE_FILE) {
        // The overwrite-safety read-precheck below calls checkReadPath, which
        // is designed to receive the ORIGINAL (lexical) path and do its own
        // dual lexical+canonical resolution internally. Passing the already-
        // canonicalized resolvedPath (e.g. macOS $TMPDIR /var/folders/... →
        // /private/var/folders/...) breaks its lexical implicit-root match, so
        // a temp-dir write — allowed by checkWritePath's implicit-root match —
        // would dead-end at a read grant that can never be satisfied. Keep the
        // canonical form only for actual execution (approvedExecutionPath).
        largeWritePathAfterApproval = pathInfo.path;
      }
    }
  }

  // Browser automation acts inside the user's live, logged-in sessions — the
  // same consequence Computer Use already gates for browser apps, so the
  // cheaper mechanism must not be the ungated one.
  //
  // The decision is made per OPERATION CLASS (read-only / interactive /
  // scripting) and per RUN MODE (attended / unattended), because the two
  // columns are genuinely different questions: attended, a dialog can ask;
  // unattended, there is nobody to ask, so the run may act only where the
  // user pre-authorized it. Order of the checks below, all fail-closed:
  //   1. unattended master switch off        → deny the whole surface
  //   2. run-permission ceiling              → deny (routing the policy verdict)
  //   3. site explicitly blocked             → deny
  //   4. operation class configured to deny  → deny
  //   5. unattended: 'ask' → the confirmation seam; then require an
  //      'allowed' site for anything that changes page state
  //   6. attended: the shipped per-site + permission-mode gate, unchanged
  {
    const opClass = classifyBrowserTool(name);
    if (opClass !== null) {
      const consequence = toLegacyBrowserToolConsequence(opClass);
      // Which column of the operation policy applies. `interactionMode` is the
      // flag the agent loop already derives for exactly this question, but it
      // is optional on the context, so re-derive from the provenance fields a
      // background run always carries and take the STRICTER of the two: a
      // context that lost its `interactionMode` on the way here must not be
      // read as "a human is watching".
      //
      // `initiatedBy` (shell-owned, like `interactionMode`) says WHO started
      // this run: a human typing into a scheduled task's conversation is
      // attended even though the conversation record carries the scheduler's
      // marker; the scheduler's own tick in that same conversation is not.
      // The derivation applies it with the scope/ceiling markers still
      // winning, so a stamped initiator can never strip a fenced run's mode.
      const derivedMode = deriveRunInteractionMode({
        ...(toolContext?.authorizationScopeId !== undefined
          ? { authorizationScopeId: toolContext.authorizationScopeId }
          : {}),
        ...(runPermissionCeiling !== null ? { runPermissionCeiling } : {}),
        ...(conversation?.triggerId !== undefined ? { triggerId: conversation.triggerId } : {}),
        ...(conversation?.scheduledTaskId !== undefined
          ? { scheduledTaskId: conversation.scheduledTaskId }
          : {}),
        ...(toolContext?.initiatedBy !== undefined ? { initiatedBy: toolContext.initiatedBy } : {}),
      });
      const runMode: 'attended' | 'unattended' =
        toolContext?.interactionMode === 'background' || derivedMode === 'background'
          ? 'unattended'
          : 'attended';

      /**
       * The run's consecutive-denial guard (browserDenialTracker.ts) measures
       * ONE thing: a model that keeps asking for browser actions a human keeps
       * refusing. So only an INTERACTION-shaped refusal is reported here —
       * an attended dialog answered "no", an IM approval denied or timed out,
       * and an ask that fail-closes because no channel could carry it (an
       * unanswerable ask IS the refusal). A standing-configuration refusal is
       * not an interaction and must NOT count: the master switch (off by
       * default), a blocked site, a policy 'deny' cell, the run-permission
       * ceiling and an unverifiable origin all refuse without anyone having
       * refused anything, and counting them would abort every unattended run
       * that touched the browser twice.
       *
       * Nothing outside this block reports at all — a file or command refusal
       * is a different conversation with the user.
       */
      const refusedByHuman = <T extends ToolApprovalDecision>(decision: T): T => {
        // The KIND matters to the tracker's R1 rule: a site grant can never
        // authorize execute_js, so it must not be able to clear a scripting
        // refusal. `opClass` is the gate's own classification of this call.
        toolContext?.reportBrowserDenial?.(opClass === 'scripting' ? 'scripting' : 'other');
        return decision;
      };
      /**
       * The mirror image on the allow side: only an allow the user CONSENTED
       * to clears the streak — a dialog they confirmed, an IM approval they
       * approved, or a standing grant they created being applied. A policy
       * auto-allow must not reset, or the guard is trivially dodged: with
       * attended read-only at its 'allow' default, a model could alternate
       * navigate (refused) / screenshot (auto-allowed, streak cleared) and
       * never trip. Set at the consent sites below, reported once at the end.
       *
       * WHICH kind of consent is carried too (R1): a `'grant'` is narrower
       * than a `'dialog'` — it was minted from approving a click and can never
       * cover `execute_js`, so the tracker refuses to let one clear a scripting
       * refusal. `null` means no consent happened.
       */
      let consented: 'dialog' | 'grant' | null = null;

      const settingsSnapshot = getSettingsReader().getSnapshot();
      const masterSwitchUnattended = settingsSnapshot.allowUnattendedBrowser === true;

      // Resolving the origin is an MCP round-trip to the browser host.
      // ATTENDED read-only skips it: snapshot/screenshot/extract run
      // constantly, a human is watching, and that path has never consulted a
      // site verdict. UNATTENDED pays it for EVERY class — reading a page the
      // user explicitly blocked is exactly the exfiltration an unattended run
      // must not do quietly, and "it was only a read" is not a defense when
      // nobody is there to notice. (`get_tabs` and other tab-less tools cost
      // nothing here: `resolveBrowserActionOrigin` returns null without a
      // round-trip when there is no `tabId`/`url` to resolve.)
      const target = consequence === 'state-changing' || runMode === 'unattended'
        ? await resolveBrowserActionTarget(
          name,
          input,
          toolContext?.conversationId,
          toolContext?.agentRunId,
        )
        : { origin: null, url: null, authState: null };
      const origin = target.origin;
      /**
       * U6 / F2.4 — the site is asking for a login (an HTTP auth challenge or
       * a redirect onto a login page, both observed by the browser host, never
       * claimed by the page). ADVISORY: read below only to REFUSE or to append
       * a note; there is no branch anywhere that turns it into an allow.
       */
      const loginRequired = target.authState === 'login_required';
      const storedVerdict = consequence === 'state-changing' || runMode === 'unattended'
        ? getSiteVerdict(origin, settingsSnapshot.browserSitePermissions ?? {})
        : 'default';
      /**
       * Money movement / government, decided from the target URL and NOTHING
       * else (see `highRiskSites.ts`'s URL-ONLY doc — page text claiming "this
       * is not a payment page" has no path into this).
       *
       * It OUTRANKS an 'allowed' grant on purpose: "always allow this bank" is
       * the exact artifact the control exists to prevent. It does NOT outrank
       * 'denied' — a site the user blocked stays blocked, and letting the
       * high-risk verdict replace it could only ever loosen things.
       */
      const highRisk = storedVerdict !== 'denied' && isHighRiskUrl(target.url);
      const siteVerdict: DecideBrowserOperationSiteVerdict = highRisk
        ? 'high-risk'
        : storedVerdict;

      const browserActionLabel = origin
        ? `${t.commandConfirm.browserAction}: ${name} (${origin})`
        : `${t.commandConfirm.browserAction}: ${name}`;
      /**
       * U7 / G1 — leave a trace of the refusal.
       *
       * Every `return { decision: 'deny' }` in this block goes through here
       * first. Before U7 a refusal produced NO browser signal at all: the run
       * result got a sentence and the model got a diagnostic, but the
       * observability buffer — and therefore the unattended task report —
       * recorded an action that simply never happened. A morning report whose
       * "blocked" section is structurally always empty is worse than none.
       *
       * Recorded for attended runs too. It changes no behavior (the buffer is
       * write-only observability), and a gate that only records half its
       * decisions is a gate whose silence means nothing.
       */
      const recordGateDenial = (reason: BrowserDenialReasonCode): void => {
        safeRecordBrowserSignal(() => buildBrowserSignalRecord(
          {
            kind: 'gate_denied',
            tool: name,
            opClass,
            ...(origin !== null ? { origin } : {}),
            reason,
            runMode,
          },
          buildBrowserSignalContext(
            browserChannelForTool(name) ?? 'builtin',
            toolContext?.conversationId,
            Date.now(),
            toolContext?.loopId,
          ),
        ));
      };

      /**
       * Refuse, and tell the run's own callback why so it can account for it.
       * The gate decides; the callback only records (see
       * `ConfirmationInfo.deniedNotice`). Without this, every unattended
       * browser refusal below would be invisible in the run result — a
       * scheduled task would report "failed" and nothing else, which is the
       * exact failure the scheduler's denial accounting exists to prevent.
       */
      const denyUnattendedBrowser = async (
        reason: BrowserDenialReasonCode,
        /** The approval channel's own sentence, when it knows something this
         *  gate's generic copy cannot say ("you declined this in chat" vs
         *  "nobody answered in five minutes"). The CODE stays the same either
         *  way — the taxonomy is what aggregates, the sentence is what reads. */
        userFacingOverride?: string,
      ): Promise<ToolApprovalDecision> => {
        const userFacingReason = userFacingOverride ?? browserDenialReasonText(reason);
        recordGateDenial(reason);
        await notifyUnattendedDenial(onRequireConfirmation, {
          command: browserActionLabel,
          level: 'warn',
          reason: userFacingReason,
          kind: 'browser',
          browserOperationClass: opClass,
          ...(origin !== null ? { browserOrigin: origin } : {}),
          allowPersistentGrant: false,
          deniedNotice: userFacingReason,
        }, toolContext?.loopId);
        return { decision: 'deny', reason: `Error: ${userFacingReason}` };
      };
      // An absent policy is the KNOWN-absent case (a store that predates v46),
      // so it takes the reviewed product default rather than
      // normalizeBrowserOperationPolicy's strictest-cell clamp, which is for a
      // present-but-malformed value (decideBrowserOperation applies that one).
      const policyVerdict = decideBrowserOperation({
        opClass,
        runMode,
        policy: settingsSnapshot.browserOperationPolicy ?? DEFAULT_BROWSER_OPERATION_POLICY,
        masterSwitchUnattended,
        siteVerdict,
        ...(origin !== null ? { targetOrigin: origin } : {}),
      });

      /**
       * The localized, actionable sentence for a refusal — the one a user
       * reads in a scheduled run's result. Deliberately NOT derived from the
       * technical reason string a ceiling/decision function returns: those are
       * hardcoded English diagnostics aimed at the model and the tool result,
       * and a real scheduled run hits the CEILING first (its capability is
       * 'scheduled'), so using the technical string there is how the run
       * result ends up in English, naming neither the master switch nor where
       * to change it. Both surfaces get what they need: the tool result keeps
       * the technical reason, the run result gets this.
       */
      const unattendedDenialCode = (): BrowserDenialReasonCode => {
        if (!masterSwitchUnattended) return 'master-switch-off';
        if (siteVerdict === 'denied') return 'site-denied';
        // Named before the generic policy sentence: "this looks like a payment
        // page" is actionable, "your policy says deny" points at a setting the
        // user never changed.
        if (highRisk) return 'high-risk-site';
        if (policyVerdict === 'deny') return 'policy-denied';
        // The ceiling refused for a reason the operation policy did not: this
        // run's capability tier carries no browser access at all.
        return 'capability-denied';
      };
      /** The one place a denial code becomes words. The report card localizes
       *  the SAME codes through its own namespace, so the run result and the
       *  morning card can never disagree about why something was blocked. */
      const browserDenialReasonText = (reason: BrowserDenialReasonCode): string => {
        switch (reason) {
          case 'master-switch-off': return t.commandConfirm.browserUnattendedDisabled;
          case 'site-denied': return t.commandConfirm.browserSiteDenied;
          case 'high-risk-site': return t.commandConfirm.browserUnattendedHighRiskSite;
          case 'policy-denied': return t.commandConfirm.browserPolicyDenied;
          case 'capability-denied': return t.commandConfirm.browserUnattendedCapabilityDenied;
          case 'origin-unverified': return t.commandConfirm.browserUnattendedOriginUnverified;
          case 'login-required': return t.commandConfirm.browserUnattendedLoginRequired;
          case 'site-not-allowed': return t.commandConfirm.browserUnattendedSiteNotAllowed;
          case 'approval-refused': return t.commandConfirm.browserUnattendedConfirmUnavailable;
          case 'user-cancelled': return t.commandConfirm.userCancelled;
        }
      };

      if (consequence === 'state-changing') {
        const browserCeilingDecision = decideStateChangingToolUnderRunPermissionCeiling(
          runPermissionCeiling,
          'browser',
          policyVerdict,
        );
        if (browserCeilingDecision.decision === 'deny') {
          // Attended runs reach the ceiling too (a capability-scoped IM
          // session with a person watching). The ceiling is the reason in that
          // column — the unattended master switch is not in play.
          const ceilingCode: BrowserDenialReasonCode = runMode === 'unattended'
            ? unattendedDenialCode()
            : 'capability-denied';
          recordGateDenial(ceilingCode);
          if (runMode === 'unattended') {
            const noticeReason = browserDenialReasonText(ceilingCode);
            await notifyUnattendedDenial(onRequireConfirmation, {
              command: browserActionLabel,
              level: 'warn',
              reason: noticeReason,
              kind: 'browser',
              browserOperationClass: opClass,
              ...(origin !== null ? { browserOrigin: origin } : {}),
              allowPersistentGrant: false,
              deniedNotice: noticeReason,
            }, toolContext?.loopId);
          }
          return browserCeilingDecision;
        }
      }
      if (siteVerdict === 'denied') {
        // Now reachable for read-only actions too, in unattended runs: a
        // blocked site is blocked for READING as well when nobody is watching.
        if (runMode === 'unattended') return await denyUnattendedBrowser(unattendedDenialCode());
        recordGateDenial('site-denied');
        return { decision: 'deny', reason: `Error: ${t.commandConfirm.browserSiteDenied}` };
      }
      if (policyVerdict === 'deny') {
        if (runMode === 'unattended') return await denyUnattendedBrowser(unattendedDenialCode());
        recordGateDenial('policy-denied');
        return { decision: 'deny', reason: `Error: ${t.commandConfirm.browserPolicyDenied}` };
      }

      if (runMode === 'unattended') {
        // An action on a page whose origin could not be determined — the host
        // probe timed out or errored, or the destination is unknowable (a
        // history navigation). Without this, a WEDGED browser host would
        // resolve every origin to null, every site verdict to 'default', and
        // an unattended run could read a site the user explicitly blocked:
        // the fail-open that the blocked-site check exists to prevent, reached
        // by breaking the lookup instead of by policy. State-changing actions
        // already fail closed further down (they require an 'allowed' site);
        // this makes reads match. Tools that act on no page at all
        // (`get_tabs`, `connection_status`, `get_downloads`) are exempt —
        // there is no site behind them to verify.
        if (browserToolTargetsPage(name) && origin === null) {
          return await denyUnattendedBrowser('origin-unverified');
        }
        /**
         * U6 / F2.4 — an expired session, with nobody here to sign in.
         *
         * Scoped to STATE-CHANGING actions on purpose. Reading a login wall is
         * how the run learns to hand back at all: refusing the read too would
         * leave the model blind, with only "denied" to report, and it is the
         * snapshot of the login page that lets it say WHICH site. Clicking and
         * scripting are refused, because every one of those would land on the
         * wall and the model's instinct is to try again.
         *
         * NOT counted as a human refusal (`refusedByHuman`): nobody refused
         * anything — the site did. Counting it would let two expired-session
         * actions abort the whole run under U4's consecutive-denial guard,
         * which measures a model arguing with a person.
         *
         * The user still hears about it: `denyUnattendedBrowser` goes through
         * U3's `notifyUnattendedDenial` → `deniedNotice` accounting, the same
         * path every other unattended refusal uses.
         */
        if (loginRequired && consequence === 'state-changing') {
          return await denyUnattendedBrowser('login-required');
        }
        // Nobody is in front of the screen: `onRequireConfirmation` here is the
        // entry point's own auto-deny (or, in a later task, an IM approval
        // round-trip), never a dialog. Route 'ask' through the single seam
        // that owns that question instead of the per-entry-point callback.
        if (policyVerdict === 'ask') {
          const approval = await resolveUnattendedConfirmation({
            info: {
              command: browserActionLabel,
              level: 'warn',
              reason: opClass === 'scripting'
                ? t.commandConfirm.browserScriptReason
                : t.commandConfirm.browserReason,
              kind: 'browser',
              browserOperationClass: opClass,
              ...(origin !== null ? { browserOrigin: origin } : {}),
              allowPersistentGrant: false,
            },
            // Provenance for whoever will deliver the approval. The
            // conversation carries the scheduler/trigger markers; anything
            // else unattended came in over a channel, so 'im' is the
            // fallback rather than a positive identification.
            source: conversation?.scheduledTaskId !== undefined
              ? 'scheduler'
              : conversation?.triggerId !== undefined ? 'trigger' : 'im',
            ...(toolContext?.conversationId !== undefined
              ? { conversationId: toolContext.conversationId }
              : {}),
            // Scopes the approval channel's coalescing and answer cache to
            // THIS run. Without it a chatty tool would push one approval
            // message per call, and an answer would have no boundary to
            // expire at.
            ...(toolContext?.loopId !== undefined ? { runKey: toolContext.loopId } : {}),
            // Stop must reach an approval channel that can wait minutes for a
            // human. Without it, pressing Stop leaves a prompt live in a chat
            // and a later "同意" would be swallowed as the answer to a run
            // that no longer exists.
            ...(toolContext?.abortSignal !== undefined
              ? { abortSignal: toolContext.abortSignal }
              : {}),
          });
          /**
           * U7 / G2 — record the human decision.
           *
           * Gated on `fresh`: the approval channel coalesces a chatty tool's
           * many calls onto ONE prompt and replays the answer, so counting
           * resolver returns would report "you approved 14 times" for a single
           * "同意". Only the call that owned the round-trip reports one.
           *
           * `outcome` absent means no approval channel was involved at all
           * (the fail-closed default resolver never asked anyone) — the gate's
           * own `gate_denied` signal already covers that refusal, and claiming
           * an IM decision happened would be a lie.
           */
          if (approval.fresh && approval.outcome) {
            const approvalOutcome = approval.outcome;
            safeRecordBrowserSignal(() => buildBrowserSignalRecord(
              {
                kind: 'approval',
                via: 'im',
                outcome: approvalOutcome,
                opClass,
                ...(origin !== null ? { origin } : {}),
              },
              buildBrowserSignalContext(
                browserChannelForTool(name) ?? 'builtin',
                toolContext?.conversationId,
                Date.now(),
                toolContext?.loopId,
              ),
            ));
          }
          if (!approval.approved) {
            // The channel's own sentence when it has one — "you declined this
            // in chat" and "nobody answered in 10 minutes" are different
            // events, and reporting both as "no confirmation channel" would
            // be wrong about what happened. The generic key stays the
            // fallback for the fail-closed default resolver, whose reason is
            // an English diagnostic.
            // Counted: this is the unattended stand-in for the dialog — a
            // human said no in chat, nobody answered in time, or there was no
            // channel to ask through at all.
            return refusedByHuman(await denyUnattendedBrowser(
              'approval-refused',
              approval.userFacingReason,
            ));
          }
          // A human (or the channel standing in for one) said yes — an
          // answer to THIS request, so it is dialog-grade consent.
          consented = 'dialog';
        }
        // Cross-origin fail-closed baseline: an unattended run acts only where
        // the user granted a standing "allowed" verdict. Reading a page is
        // exempt (it changes nothing); clicking, navigating and scripting are
        // not. A later task refines this per-origin.
        if (consequence === 'state-changing') {
          // Not counted: "this origin has no standing grant" is configuration,
          // not a refusal anyone issued.
          if (siteVerdict !== 'allowed') {
            return await denyUnattendedBrowser('site-not-allowed');
          }
          // The user's own standing "allow this site" grant is what let this
          // act — a consented allow, but a GRANT-grade one (R1): it can never
          // answer for execute_js, so it must not clear a scripting refusal.
          // An unattended 'ask' that a human just approved above already set
          // 'dialog'; do not weaken it back down to 'grant'.
          consented = consented ?? 'grant';
        }
        // Approved by policy (+ site grant) — an unattended run has no
        // conversation-grant/dialog concept, so nothing further to do.
      } else if (consequence === 'state-changing') {
        // ── Attended, state-changing: unchanged from before the policy layer.
        // In this column the policy is a RESTRICTION layer only — 'deny' short
        // circuits above, and both 'allow' and 'ask' fall through to the
        // shipped per-site + permission-mode gate. Making 'allow' skip that
        // gate would silently drop the confirmation dialog for click/fill,
        // which the default attended column marks 'allow'.
        //
        // Two grant scopes: a persistent per-site verdict (settingsStore,
        // written from the dialog's "always allow this site" / revocable in
        // Settings) and the per-conversation TTL grant ("just this once").
        // Precedence: denied site > allowed site > conversation grant > ask.
        // Scripting (execute_js) is a stronger capability than clicking: the
        // dialog promises "each run asks separately", so it must neither ride
        // the conversation grant nor a persistent site grant.
        const scripting = isScriptingBrowserTool(name);
        // A high-risk page is excluded from BOTH grant scopes, for the same
        // reason scripting is: the conversation grant was minted from a dialog
        // about some ordinary page, and the per-site verdict cannot even be
        // 'allowed' here (the escalation above replaced it). Without the
        // explicit `!highRisk` the conversation grant would still wave a
        // transfer page through on the strength of an unrelated click.
        const granted =
          !scripting && !highRisk &&
          (hasBrowserGrant(toolContext?.conversationId) || siteVerdict === 'allowed');
        const decision = strategy.decideOtherTool(consequence, granted);
        if (decision !== 'allow') {
          if (!onRequireConfirmation) {
            // No confirmation channel — fail closed rather than silently
            // acting in the user's session. Sites the user explicitly allowed
            // were already let through above. Counted for the same reason the
            // unattended no-channel case is: the gate needed an answer from a
            // human and could not get one, so an insistent model must not be
            // able to keep re-asking forever.
            recordGateDenial('approval-refused');
            return refusedByHuman({ decision: 'deny', reason: `Error: ${t.commandConfirm.browserDenied}` });
          }
          safeRecordBrowserSignal(() => buildBrowserSignalRecord(
            { kind: 'confirm_prompt', origin: origin ?? undefined },
            buildBrowserSignalContext(
              browserChannelForTool(name) ?? 'builtin',
              toolContext?.conversationId,
              Date.now(),
              toolContext?.loopId,
            ),
          ));
          const confirmed = await onRequireConfirmation({
            command: browserActionLabel,
            level: 'warn',
            reason: scripting
              ? t.commandConfirm.browserScriptReason
              : highRisk
                ? t.commandConfirm.browserHighRiskReason
                : t.commandConfirm.browserReason,
            kind: 'browser',
            browserOperationClass: opClass,
            browserOrigin: origin ?? undefined,
            // No "always allow this site" for a bank or a checkout page — the
            // standing grant is the artifact this control exists to prevent.
            allowPersistentGrant: !scripting && !highRisk && origin !== null,
          }, toolContext?.loopId);
          if (!confirmed) {
            recordGateDenial('user-cancelled');
            return refusedByHuman({ decision: 'deny', reason: t.commandConfirm.userCancelled });
          }
          consented = 'dialog';
          // A script approval covers that one run only — minting the
          // conversation grant from it would silently unlock 30 minutes of
          // click/fill/navigate the user never approved. Same for a high-risk
          // page: confirming one transfer must not buy 30 minutes of silent
          // clicking everywhere else in the conversation.
          if (!scripting && !highRisk) grantBrowserAutomation(toolContext?.conversationId);
        } else if (granted) {
          // No dialog because the user already granted this — a standing site
          // verdict, or the conversation grant minted from an earlier dialog.
          // Both are consent, unlike an unconditional permission-mode allow —
          // but GRANT-grade consent (R1), which cannot clear a scripting
          // refusal.
          consented = 'grant';
        }
      } else if (policyVerdict === 'ask') {
        // Attended read-only explicitly configured to ask. Never reached under
        // the default policy (attended read-only is 'allow'), but the setting
        // must do something when a user picks it.
        if (!onRequireConfirmation) {
          recordGateDenial('approval-refused');
          return refusedByHuman({ decision: 'deny', reason: `Error: ${t.commandConfirm.browserDenied}` });
        }
        const confirmed = await onRequireConfirmation({
          command: browserActionLabel,
          level: 'warn',
          reason: t.commandConfirm.browserReason,
          kind: 'browser',
          browserOperationClass: opClass,
          allowPersistentGrant: false,
        }, toolContext?.loopId);
        if (!confirmed) {
          recordGateDenial('user-cancelled');
          return refusedByHuman({ decision: 'deny', reason: t.commandConfirm.userCancelled });
        }
        consented = 'dialog';
      }
      // A consented allow ends the streak. An action that merely passed the
      // policy (attended read-only under the shipped default is the common
      // one) leaves the counter exactly where it was.
      if (consented) toolContext?.reportBrowserAllow?.(consented);

      // Everything below this line has approved the call. Record what the gate
      // decided ON so the executor can pin it at the host — see
      // `BrowserExecutionPin`. Set on EVERY approved browser call, including
      // read-only and attended ones: the host decides what to enforce, and a
      // pin that is only attached sometimes is a pin whose absence means
      // nothing.
      browserExecutionPin = {
        runMode,
        ...(origin !== null ? { expectedOrigin: origin } : {}),
        ...(loginRequired ? { loginRequired: true as const } : {}),
      };
    }
  }

  // Self-extension: creating a subagent, installing an MCP server, rewriting
  // the persona, or changing a persistent automation writes durable state that
  // shapes later turns/runs. No per-conversation grant here — these are rare,
  // deliberate acts, each worth its own ask.
  {
    const selfExtension = classifySelfExtension(name, input);
    if (selfExtension) {
      const selfExtensionCeilingDecision = decideStateChangingToolUnderRunPermissionCeiling(
        runPermissionCeiling,
        'self-extension',
      );
      if (selfExtensionCeilingDecision.decision === 'deny') {
        return selfExtensionCeilingDecision;
      }
      const decision = strategy.decideOtherTool('state-changing', false);
      if (decision !== 'allow') {
        if (!onRequireConfirmation) {
          return { decision: 'deny', reason: `Error: ${t.commandConfirm.selfExtensionDenied}` };
        }
        const confirmed = await onRequireConfirmation({
          command: selfExtension.summary,
          level: 'warn',
          reason: t.commandConfirm.selfExtensionReason,
          kind: 'self-extension',
        }, toolContext?.loopId);
        if (!confirmed) {
          return { decision: 'deny', reason: t.commandConfirm.userCancelled };
        }
      }
    }
  }

  // Enterprise policy pre-check — runs before builtin and MCP tools
  {
    const policy = getCurrentPolicy()
    const summary = typeof input === 'object'
      ? JSON.stringify(input).slice(0, 200)
      : String(input).slice(0, 200)
    const policyCheck = checkTool(policy, name, summary)
    if (policyCheck.decision === 'deny') {
      return { decision: 'deny', reason: `Error: [policy] ${policyCheck.reason}` }
    }
    if (policyCheck.decision === 'confirm') {
      if (toolContext?.interactionMode === 'background') {
        return { decision: 'deny', reason: `Error: [policy] ${policyCheck.reason ?? 'confirmation unavailable in background run'}` }
      }
      const allowed = await showPolicyConfirm(policyCheck.reason ?? '此操作需要企业策略二次确认')
      if (!allowed) {
        return { decision: 'deny', reason: `Error: [policy] user declined confirmation` }
      }
    }
  }

  if (largeWritePathAfterApproval) {
    // The preToolCall guard cannot inspect a path before approval: that would
    // turn exists/stat into a metadata oracle.  Enterprise policy must also
    // win before any probe.  Finally require an actual read grant — scoped
    // write and read capabilities are intentionally independent — and fail
    // closed if the run has only write authority.
    let readCheck = await checkReadPath(
      largeWritePathAfterApproval,
      toolContext?.authorizationScopeId,
    );
    if (
      !readCheck.allowed
      && readCheck.needsPermission
      && readCheck.permissionPath
      && onRequireFilePermission
    ) {
      const granted = await onRequireFilePermission({
        path: readCheck.permissionPath,
        capability: 'read',
        toolName: TOOL_NAMES.WRITE_FILE,
      }, toolContext?.loopId);
      if (granted) {
        readCheck = await checkReadPath(
          largeWritePathAfterApproval,
          toolContext?.authorizationScopeId,
        );
      }
    }
    if (!readCheck.allowed) {
      return {
        decision: 'deny',
        reason: 'Error: write_file requires read authorization for its overwrite safety check; authorize read access to this path, then retry',
      };
    }
    const blockReason = await getLargeWriteBlockReason(largeWritePathAfterApproval);
    if (blockReason) {
      return { decision: 'deny', reason: blockReason };
    }
  }

  return {
    decision: 'allow',
    ...(approvedExecutionPath ? { executionPath: approvedExecutionPath } : {}),
    ...(browserExecutionPin ? { browserExecution: browserExecutionPin } : {}),
  };
}

/**
 * `get_downloads` is classified pageless + read-only, so it is exempt from
 * every site verdict: the gate never resolves an origin for it, and the host
 * returns the last 20 downloads of the whole browser session with zero
 * filtering. That is a hole the site verdicts were supposed to close — a
 * download record carries the URL it came from, so a site the user explicitly
 * BLOCKED can still put its addresses (and filenames) into the model's context
 * through this one tool.
 *
 * The filter runs shell-side rather than in the host because the verdicts live
 * in settingsStore, which the main process does not have.
 *
 * Two tiers, matching the rest of the gate:
 * - always: drop entries from a `'denied'` origin. A blocked site is blocked in
 *   both run modes, exactly like the read-only refusal U2 added.
 * - unattended additionally: keep ONLY `'allowed'` origins. An unattended run
 *   acts and reads within the set the user granted; a download from an
 *   unlisted site is outside it. (Attended does NOT narrow to the allowed set —
 *   a human asking "what did I just download" must still get the answer.)
 *
 * An entry whose url does not parse is treated as unknown: dropped unattended,
 * kept attended. Fail-safe both ways.
 */
export function filterDownloadsByOrigin(
  result: ToolResult,
  runMode: 'attended' | 'unattended',
  sitePermissions: Record<string, 'allowed' | 'denied'>,
): ToolResult {
  if (typeof result !== 'string') return result;
  // An error string ("Error: ...") is not a listing; leave it alone.
  if (result.startsWith('Error:')) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    // Unverifiable output. Attended keeps its exact shipped behavior (a human
    // is reading it); unattended refuses rather than passing through a list it
    // could not check — the same fail-closed reading as an unverifiable origin.
    return runMode === 'unattended'
      ? 'Error: the download list could not be verified against your site permissions, so it was withheld from this unattended run'
      : result;
  }
  if (!Array.isArray(parsed)) return result;
  const kept = parsed.filter((entry) => {
    const url = entry && typeof entry === 'object'
      ? (entry as { url?: unknown }).url
      : undefined;
    const origin = normalizeBrowserOrigin(typeof url === 'string' ? url : undefined);
    const verdict = getSiteVerdict(origin, sitePermissions);
    if (verdict === 'denied') return false;
    return runMode === 'unattended' ? verdict === 'allowed' : true;
  });
  if (kept.length === parsed.length) return result;
  return JSON.stringify(kept, null, 2);
}

/**
 * What replaces a blocked tab's `url`/`title`. English, like every other
 * LLM-facing string the model reads out of a tool result, and deliberately a
 * SENTENCE rather than an empty string: `''` is what the host itself writes
 * when Chrome supplies no url, so a silent blank would read as "this tab has
 * no address" instead of "you are not allowed to see this one".
 */
const REDACTED_TAB_FIELD = '[hidden: you blocked this site, and nobody is watching this run]';

/**
 * `get_tabs` is classified pageless + read-only, so — exactly like its sibling
 * `get_downloads` — it is exempt from every site verdict: no origin is
 * resolved for it, and the handler answers from `chrome.tabs.query({})` (the
 * extension channel) or the conversation's automation views (the built-in
 * one). The extension channel is the one driving the user's REAL, logged-in
 * Chrome, and it reports every normal-window tab's `url` and `title` plus
 * `summary.currentTabUrl` — with no site permission check anywhere.
 *
 * That contradicts the rule the gate writes down for itself a few hundred
 * lines up: when nobody is watching, a site the user BLOCKED may not even be
 * read. A denied site could still put its addresses and page titles into an
 * unattended model's context through this one tool.
 *
 * Two deliberate differences from `filterDownloadsByOrigin`:
 *
 * 1. UNATTENDED ONLY. Attended output is byte-identical to what it has always
 *    been — a human looking at their own browser is not the threat here.
 * 2. REDACT, don't drop. A download entry IS its url, so removing the url
 *    leaves an empty husk and dropping the row is the only sensible move. A
 *    tab is an addressable object: `tabId` is the handle every other browser
 *    tool takes, and the row also carries `active`/`isCurrentTab`. Dropping
 *    rows would (a) contradict `summary.totalTabs`/`totalWindows`, which are
 *    computed host-side and would still count the hidden tabs, leaving the
 *    model with a self-contradictory listing it may well retry, and (b) teach
 *    it a false world model ("the user has 3 tabs open"), which invites it to
 *    navigate to that very site itself. Keeping the row with the address
 *    hidden says the true thing: there is a tab here you may not look at.
 *
 * Redaction grants nothing: the `tabId` that survives is not a capability.
 * Every action against it re-resolves the tab's REAL origin through the gate's
 * own `get_tabs` probe, which calls `mcpManager.callTool` directly and never
 * passes through this filter — so the gate still sees `blocked.com` and still
 * refuses, for the right reason.
 *
 * Scope: only a `'denied'` verdict is hidden. This mirrors the gate's own
 * unattended READ policy (read-only is `'allow'` by default and refused only
 * on a blocked site) rather than `filterDownloadsByOrigin`'s stricter
 * allowed-only narrowing — an unattended run may legitimately read a
 * default-verdict page it navigated to (`snapshot` on that tab is allowed
 * today), so hiding that same page's title here would be the two halves of
 * one gate disagreeing again.
 */
export function filterTabsBySitePermissions(
  result: ToolResult,
  runMode: 'attended' | 'unattended',
  sitePermissions: Record<string, 'allowed' | 'denied'>,
): ToolResult {
  // Attended keeps its exact shipped behavior.
  if (runMode !== 'unattended') return result;
  if (typeof result !== 'string') return result;
  // An error string is not a listing; leave it alone.
  if (result.startsWith('Error:')) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    // Same fail-closed reading as an unverifiable download listing: an
    // unattended run does not get output that could not be checked.
    return 'Error: the tab list could not be verified against your site permissions, so it was withheld from this unattended run';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  const doc = parsed as { summary?: unknown; windows?: unknown };
  if (!Array.isArray(doc.windows)) return result;

  let redacted = false;
  const isDenied = (url: unknown): boolean =>
    typeof url === 'string'
    && getSiteVerdict(normalizeBrowserOrigin(url), sitePermissions) === 'denied';

  const windows = doc.windows.map((win) => {
    if (!win || typeof win !== 'object') return win;
    const window = win as { tabs?: unknown };
    if (!Array.isArray(window.tabs)) return win;
    return {
      ...window,
      tabs: window.tabs.map((tab) => {
        if (!tab || typeof tab !== 'object') return tab;
        const entry = tab as { url?: unknown };
        if (!isDenied(entry.url)) return tab;
        redacted = true;
        return { ...entry, url: REDACTED_TAB_FIELD, title: REDACTED_TAB_FIELD };
      }),
    };
  });

  // The summary repeats the current tab's address, so filtering only the rows
  // would leave the leak in place for the one tab most likely to be blocked.
  let summary = doc.summary;
  if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
    const current = summary as { currentTabUrl?: unknown };
    if (isDenied(current.currentTabUrl)) {
      redacted = true;
      summary = { ...current, currentTabUrl: REDACTED_TAB_FIELD, currentTabTitle: REDACTED_TAB_FIELD };
    }
  }

  if (!redacted) return result;
  return JSON.stringify({ ...doc, summary, windows }, null, 2);
}

/**
 * Execute a tool by name, checking both builtin and MCP tools
 * With optional dangerous command confirmation and file permission callbacks.
 * Respects the current permission mode (default/auto/strict).
 */
export async function executeAnyTool(
  name: string,
  input: Record<string, unknown>,
  onRequireConfirmation?: CommandConfirmCallback,
  onRequireFilePermission?: FilePermissionCallback,
  toolContext?: ToolExecutionContext,
  /** Current context window usage (0-100). Scales truncation limits under pressure. */
  contextUsagePercent?: number
): Promise<ToolResult> {
  const throwIfAborted = (): void => {
    if (!toolContext?.abortSignal?.aborted) return;
    const error = new Error('Tool execution aborted');
    error.name = 'AbortError';
    throw error;
  };

  throwIfAborted();
  // P1-3d-3: approval chain extracted to checkToolApproval — see its doc.
  // Behavior-preserving: same deny-reason strings, same order, same callbacks.
  const approval = await checkToolApproval(name, input, toolContext, onRequireConfirmation, onRequireFilePermission);
  if (approval.decision === 'deny') {
    return approval.reason ?? `Error: tool "${name}" was denied`;
  }
  // Approval may await AI review, a user confirmation, or file permission.
  // Stop can win during any of those awaits; never consume a stale allow by
  // starting a builtin/MCP side effect after the run crossed its abort fence.
  throwIfAborted();

  const executionInput = approval.executionPath && FILE_TOOL_PATH_MAP[name]
    ? { ...input, path: approval.executionPath }
    : input;

  // First check builtin tools. A Labs-gated-off tool stays in the registry but
  // is treated as absent here too, so a stale/hallucinated tool_use falls
  // through to the "Unknown tool" fail-safe instead of silently executing.
  if (toolRegistry.has(name) && !isToolGatedOff(name)) {
    const result = await toolRegistry.execute(name, executionInput, toolContext);
    // Only truncate string results; rich content (images) passes through
    if (typeof result === 'string') {
      // File-tool OS-permission errors get a friendly grant-guide (not
      // truncated — the raw error is short). See applyOSPermissionGuideIfNeeded.
      const guided = applyOSPermissionGuideIfNeeded(name, result);
      if (guided !== result) return guided;
      return truncateToolResult(name, result, contextUsagePercent);
    }
    return result;
  }

  // Check MCP tools (format: serverName__toolName).
  //
  // The parse is the SHARED one (U9 / C1) — the same function the browser
  // authorization layer classifies with. It used to be `split('__', 2)` here,
  // whose limit-2 TRUNCATION silently discarded everything after the second
  // separator: `abu-browser__execute_js__x` was gated as the unknown tool
  // `execute_js__x` (→ the weaker 'interactive' bucket) and then dispatched as
  // `execute_js`, so the door and the room disagreed about which tool this
  // was. A name that does not round-trip now falls through to the "Unknown
  // tool" fail-safe below — the same thing the builtin branch above already
  // does with a name it does not recognize, instead of the MCP branch's old
  // "any suffix is fine as long as the server is connected".
  const parsedName = parseNamespacedToolName(name);
  if (parsedName !== null) {
    const { serverName, toolName } = parsedName;
    if (mcpManager.isConnected(serverName)) {
      const isBrowserTool = classifyBrowserTool(name) !== null;
      const startedAt = Date.now();
      let result: ToolResult;
      try {
        result = await mcpManager.callTool(serverName, toolName, executionInput, {
          conversationId: toolContext?.conversationId,
          agentRunId: toolContext?.agentRunId,
          signal: toolContext?.abortSignal,
          // Approval-time origin pin — rides `_meta`, never the tool schema, so
          // the model can neither read nor forge it. See `BrowserExecutionPin`.
          ...(approval.browserExecution?.expectedOrigin !== undefined
            ? { expectedOrigin: approval.browserExecution.expectedOrigin }
            : {}),
          ...(approval.browserExecution?.runMode === 'unattended'
            ? { unattended: true }
            : {}),
        });
      } catch (err) {
        if (isBrowserTool) {
          try {
            const message = err instanceof Error ? err.message : String(err);
            recordBrowserToolCallSignal(name, toolContext, executionInput, startedAt, `Error: ${message}`);
          } catch {
            // Observability must never change product behavior.
          }
        }
        throw err;
      }
      if (isBrowserTool) {
        try {
          recordBrowserToolCallSignal(name, toolContext, executionInput, startedAt, browserSignalToolResultToString(result));
        } catch {
          // Observability must never change product behavior.
        }
      }
      if (toolName === 'get_downloads' && isBrowserTool) {
        result = filterDownloadsByOrigin(
          result,
          approval.browserExecution?.runMode ?? 'unattended',
          getSettingsReader().getSnapshot().browserSitePermissions ?? {},
        );
      }
      // The sibling leak (U9 / I1): `get_tabs` reports every tab's url and
      // title, including sites the user blocked. Same shell-side placement and
      // same fail-safe runMode default as the downloads filter above — and
      // deliberately AFTER the call, so the gate's own origin probe (which
      // calls mcpManager directly) still sees the unredacted truth.
      if (toolName === 'get_tabs' && isBrowserTool) {
        result = filterTabsBySitePermissions(
          result,
          approval.browserExecution?.runMode ?? 'unattended',
          getSettingsReader().getSnapshot().browserSitePermissions ?? {},
        );
      }
      // U6 / F2.4, the ATTENDED half of the login-expiry split. The action was
      // allowed and ran (a human is here, and they may well be signing in);
      // what changes is that the result now SAYS the session expired, so the
      // model asks the user to sign in instead of retrying into the wall.
      // Unattended never reaches this line — the gate refused above.
      if (isBrowserTool && approval.browserExecution?.loginRequired && typeof result === 'string') {
        result = `${result}\n\n${getI18n().commandConfirm.browserLoginRequiredHint}`;
      }
      // Only truncate string results; rich content (images) passes through
      if (typeof result === 'string') {
        return truncateToolResult(name, result, contextUsagePercent);
      }
      return result;
    }
  }

  return `Error: Unknown tool "${name}"`;
}

// ── OS Permission Error Detection ──
// The detection + guide logic lives in the pure, store-free `osPermissionGuide`
// module (re-exported here for existing importers) so the sidecar's local
// path can share it without dragging registry.ts → chatStore — see that
// module's doc. `FILE_TOOL_NAMES` there mirrors FILE_TOOL_PATH_MAP's keys; a
// registry.test.ts case asserts the two stay in sync.
export { applyOSPermissionGuideIfNeeded, FILE_TOOL_NAMES } from './osPermissionGuide';

// Re-export types for convenience
export type { ConfirmationInfo, DangerLevel };

// ── HMR: re-register builtin tools when this module is hot-reloaded ──
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // Module replaced — toolRegistry is now a fresh empty instance.
    // Re-register builtins so tools don't disappear during development.
    import('./builtins').then(({ registerBuiltinTools }) => {
      registerBuiltinTools();
      console.info('[HMR] Builtin tools re-registered');
    });
  });
}
