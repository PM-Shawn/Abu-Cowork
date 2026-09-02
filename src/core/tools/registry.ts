import type { ToolDefinition, ToolResult, ToolExecutionContext } from '../../types';
import { mcpManager } from '../mcp/client';
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
} from '../permissions/browserToolPolicy';
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
export interface ToolApprovalDecision {
  decision: 'allow' | 'deny';
  reason?: string;
  /** Canonical file path that the executor must use for an approved file tool. */
  executionPath?: string;
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
 * Resolve which site a browser action targets, as an exact origin.
 *
 * `navigate` carries the destination in its input; every other action only
 * carries a `tabId`, so we ask the same browser server for its tab list
 * (`get_tabs` returns each tab's URL) and match the id. Best-effort: any
 * failure resolves to null, which the gate treats as "unknown site" — the
 * action can still be approved, but only one conversation at a time, never
 * persistently.
 */
async function resolveBrowserActionOrigin(
  namespacedName: string,
  input: Record<string, unknown>,
  conversationId?: string,
  agentRunId?: string,
): Promise<string | null> {
  const separator = namespacedName.indexOf('__');
  const serverName = namespacedName.slice(0, separator);
  const toolName = namespacedName.slice(separator + 2);

  if (toolName === 'navigate') {
    // Only `goto` actually navigates to `input.url`. For back/forward/reload
    // the executor ignores `url` entirely, so trusting it here would let a
    // decoy url ride an allowed-site verdict while the browser goes somewhere
    // else (history/reload). Destination is unknowable → null → ask.
    const action = typeof input.action === 'string' ? input.action : 'goto';
    if (action !== 'goto') return null;
    const url = typeof input.url === 'string' ? input.url : undefined;
    return url ? normalizeBrowserOrigin(url) : null;
  }

  const tabId = Number(input.tabId);
  if (!Number.isFinite(tabId)) return null;
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
    if (result === null || typeof result !== 'string') return null;
    const parsed = JSON.parse(result) as {
      windows?: Array<{ tabs?: Array<{ tabId?: number; url?: string }> }>;
    };
    for (const win of parsed.windows ?? []) {
      for (const tab of win.tabs ?? []) {
        if (tab.tabId === tabId) return normalizeBrowserOrigin(tab.url);
      }
    }
    return null;
  } catch {
    return null;
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
  const separator = namespacedName.indexOf('__');
  const bareToolName = separator === -1 ? namespacedName : namespacedName.slice(separator + 2);
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

  const context = buildBrowserSignalContext(browserChannelForTool(namespacedName) ?? 'builtin', conversationId);
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
      const derivedMode = deriveRunInteractionMode({
        ...(toolContext?.authorizationScopeId !== undefined
          ? { authorizationScopeId: toolContext.authorizationScopeId }
          : {}),
        ...(runPermissionCeiling !== null ? { runPermissionCeiling } : {}),
        ...(conversation?.triggerId !== undefined ? { triggerId: conversation.triggerId } : {}),
        ...(conversation?.scheduledTaskId !== undefined
          ? { scheduledTaskId: conversation.scheduledTaskId }
          : {}),
      });
      const runMode: 'attended' | 'unattended' =
        toolContext?.interactionMode === 'background' || derivedMode === 'background'
          ? 'unattended'
          : 'attended';

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
      const origin = consequence === 'state-changing' || runMode === 'unattended'
        ? await resolveBrowserActionOrigin(
          name,
          input,
          toolContext?.conversationId,
          toolContext?.agentRunId,
        )
        : null;
      const siteVerdict = consequence === 'state-changing' || runMode === 'unattended'
        ? getSiteVerdict(origin, settingsSnapshot.browserSitePermissions ?? {})
        : 'default';

      const browserActionLabel = origin
        ? `${t.commandConfirm.browserAction}: ${name} (${origin})`
        : `${t.commandConfirm.browserAction}: ${name}`;
      /**
       * Refuse, and tell the run's own callback why so it can account for it.
       * The gate decides; the callback only records (see
       * `ConfirmationInfo.deniedNotice`). Without this, every unattended
       * browser refusal below would be invisible in the run result — a
       * scheduled task would report "failed" and nothing else, which is the
       * exact failure the scheduler's denial accounting exists to prevent.
       */
      const denyUnattendedBrowser = async (
        userFacingReason: string,
      ): Promise<ToolApprovalDecision> => {
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
      const unattendedDenialReason = (): string => {
        if (!masterSwitchUnattended) return t.commandConfirm.browserUnattendedDisabled;
        if (siteVerdict === 'denied') return t.commandConfirm.browserSiteDenied;
        if (policyVerdict === 'deny') return t.commandConfirm.browserPolicyDenied;
        // The ceiling refused for a reason the operation policy did not: this
        // run's capability tier carries no browser access at all.
        return t.commandConfirm.browserUnattendedCapabilityDenied;
      };

      if (consequence === 'state-changing') {
        const browserCeilingDecision = decideStateChangingToolUnderRunPermissionCeiling(
          runPermissionCeiling,
          'browser',
          policyVerdict,
        );
        if (browserCeilingDecision.decision === 'deny') {
          if (runMode === 'unattended') {
            const noticeReason = unattendedDenialReason();
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
        return runMode === 'unattended'
          ? await denyUnattendedBrowser(unattendedDenialReason())
          : { decision: 'deny', reason: `Error: ${t.commandConfirm.browserSiteDenied}` };
      }
      if (policyVerdict === 'deny') {
        return runMode === 'unattended'
          ? await denyUnattendedBrowser(unattendedDenialReason())
          : { decision: 'deny', reason: `Error: ${t.commandConfirm.browserPolicyDenied}` };
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
          return await denyUnattendedBrowser(t.commandConfirm.browserUnattendedOriginUnverified);
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
          if (!approval.approved) {
            // The channel's own sentence when it has one — "you declined this
            // in chat" and "nobody answered in 10 minutes" are different
            // events, and reporting both as "no confirmation channel" would
            // be wrong about what happened. The generic key stays the
            // fallback for the fail-closed default resolver, whose reason is
            // an English diagnostic.
            return await denyUnattendedBrowser(
              approval.userFacingReason ?? t.commandConfirm.browserUnattendedConfirmUnavailable,
            );
          }
        }
        // Cross-origin fail-closed baseline: an unattended run acts only where
        // the user granted a standing "allowed" verdict. Reading a page is
        // exempt (it changes nothing); clicking, navigating and scripting are
        // not. A later task refines this per-origin.
        if (consequence === 'state-changing' && siteVerdict !== 'allowed') {
          return await denyUnattendedBrowser(t.commandConfirm.browserUnattendedSiteNotAllowed);
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
        const granted =
          !scripting &&
          (hasBrowserGrant(toolContext?.conversationId) || siteVerdict === 'allowed');
        const decision = strategy.decideOtherTool(consequence, granted);
        if (decision !== 'allow') {
          if (!onRequireConfirmation) {
            // No confirmation channel — fail closed rather than silently
            // acting in the user's session. Sites the user explicitly allowed
            // were already let through above.
            return { decision: 'deny', reason: `Error: ${t.commandConfirm.browserDenied}` };
          }
          safeRecordBrowserSignal(() => buildBrowserSignalRecord(
            { kind: 'confirm_prompt', origin: origin ?? undefined },
            buildBrowserSignalContext(browserChannelForTool(name) ?? 'builtin', toolContext?.conversationId),
          ));
          const confirmed = await onRequireConfirmation({
            command: browserActionLabel,
            level: 'warn',
            reason: scripting ? t.commandConfirm.browserScriptReason : t.commandConfirm.browserReason,
            kind: 'browser',
            browserOperationClass: opClass,
            browserOrigin: origin ?? undefined,
            allowPersistentGrant: !scripting && origin !== null,
          }, toolContext?.loopId);
          if (!confirmed) {
            return { decision: 'deny', reason: t.commandConfirm.userCancelled };
          }
          // A script approval covers that one run only — minting the
          // conversation grant from it would silently unlock 30 minutes of
          // click/fill/navigate the user never approved.
          if (!scripting) grantBrowserAutomation(toolContext?.conversationId);
        }
      } else if (policyVerdict === 'ask') {
        // Attended read-only explicitly configured to ask. Never reached under
        // the default policy (attended read-only is 'allow'), but the setting
        // must do something when a user picks it.
        if (!onRequireConfirmation) {
          return { decision: 'deny', reason: `Error: ${t.commandConfirm.browserDenied}` };
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
          return { decision: 'deny', reason: t.commandConfirm.userCancelled };
        }
      }
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
  };
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

  // Check MCP tools (format: serverName__toolName)
  if (name.includes('__')) {
    const [serverName, toolName] = name.split('__', 2);
    if (mcpManager.isConnected(serverName)) {
      const isBrowserTool = classifyBrowserTool(name) !== null;
      const startedAt = Date.now();
      let result: ToolResult;
      try {
        result = await mcpManager.callTool(serverName, toolName, executionInput, {
          conversationId: toolContext?.conversationId,
          agentRunId: toolContext?.agentRunId,
          signal: toolContext?.abortSignal,
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
