import type { ToolDefinition, ToolResult, ToolExecutionContext } from '../../types';
import { mcpManager } from '../mcp/client';
import { analyzeCommand, type ConfirmationInfo, type DangerLevel } from './commandSafety';
import { checkReadPath, checkWritePath, checkListPath, authorizeWorkspace } from './pathSafety';
import { getI18n } from '../../i18n';
import { truncateToolResult } from '../context/truncation';
import { getSettingsReader } from '../agent/ports/settingsReader';
import { useChatStore } from '../../stores/chatStore';
import { getPermissionStrategy } from '../permissions/permissionMode';
import { classifyBrowserTool, grantBrowserAutomation, hasBrowserGrant } from '../permissions/browserToolPolicy';
import { classifySelfExtension } from '../permissions/selfExtensionPolicy';
import { analyzeCommandBoundary, type CmdBoundary } from '../permissions/commandBoundary';
import { reviewAction } from '../safety/reviewer';
import { getLoopContext } from '../agent/permissionBridge';
import { homeDir } from '@tauri-apps/api/path';
import { TOOL_NAMES } from './toolNames';
import { applyOSPermissionGuideIfNeeded } from './osPermissionGuide';
import { isLabsFlagOn } from '../labs/resolve';
import { LABS_TODOS_INBOX } from '../labs/registry';

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

function isToolGatedOff(name: string): boolean {
  const experimentId = LABS_GATED_TOOLS[name];
  return experimentId !== undefined && !isLabsFlagOn(experimentId);
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
 */
const PLAYWRIGHT_BROWSER_TOOLS = new Set([
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
 * Callback type for command confirmation
 */
export type CommandConfirmCallback = (info: ConfirmationInfo) => Promise<boolean>;

/**
 * Callback type for file permission requests
 */
export type FilePermissionCallback = (request: {
  path: string;
  capability: 'read' | 'write';
  toolName: string;
}) => Promise<boolean>;

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
export async function checkToolApproval(
  name: string,
  input: Record<string, unknown>,
  toolContext?: ToolExecutionContext,
  onRequireConfirmation?: CommandConfirmCallback,
  onRequireFilePermission?: FilePermissionCallback,
): Promise<ToolApprovalDecision> {
  const t = getI18n();
  const convPermissionMode = toolContext?.conversationId
    ? useChatStore.getState().conversations[toolContext.conversationId]?.permissionMode
    : undefined;
  const permissionMode = convPermissionMode ?? getSettingsReader().getSnapshot().permissionMode;
  const strategy = getPermissionStrategy(permissionMode);

  // Safety check for run_command tool
  if (name === TOOL_NAMES.RUN_COMMAND) {
    const command = input.command as string;
    if (command) {
      const analysis = analyzeCommand(command);

      // Block dangerous commands — always enforced regardless of permission mode
      if (analysis.level === 'block') {
        return { decision: 'deny', reason: `Error: ${t.commandConfirm.blocked}: ${analysis.reason}` };
      }

      // Best-effort boundary check: only matters for safe, non-read-only commands
      // (risky commands already gate on content; autonomous never gates). Detects
      // commands that write outside the working dirs (e.g. `cp secret ~/Desktop/x`).
      let boundary: CmdBoundary = 'unknown';
      if (!analysis.readOnly && analysis.level === 'safe' && permissionMode !== 'autonomous') {
        const cwd = (input.cwd as string | undefined) || toolContext?.workspacePath || undefined;
        boundary = analyzeCommandBoundary(command, cwd, await getCachedHomeDir());
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
      if (outcome === 'confirm' && onRequireConfirmation) {
        const confirmed = await onRequireConfirmation({
          command,
          level: analysis.level,
          reason: reviewReason || analysis.reason,
        });
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
        ? checkWritePath
        : (name === TOOL_NAMES.LIST_DIRECTORY ? checkListPath : checkReadPath);

      const pathCheck = await checkFn(pathInfo.path);

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
              });
              if (!granted) {
                return { decision: 'deny', reason: `[${t.toolErrors.userDeniedAccess} ${pathCheck.permissionPath}]` };
              }
              // Permission granted — re-check (should now pass since authorizeWorkspace was called)
              const recheck = await checkFn(pathInfo.path);
              if (!recheck.allowed) {
                return { decision: 'deny', reason: `Error: ${recheck.reason || t.toolErrors.pathAccessDenied}` };
              }
            } else {
              // No callback available (shouldn't happen in normal flow)
              return { decision: 'deny', reason: `Error: ${t.toolErrors.needsAuthorization} ${pathCheck.permissionPath}` };
            }
          } else {
            // allow → auto-authorize the workspace for this path
            authorizeWorkspace(pathCheck.permissionPath);
          }
        } else {
          // Hard blocked — always enforced regardless of permission mode
          return { decision: 'deny', reason: `Error: ${pathCheck.reason}` };
        }
      }
    }
  }

  // Browser automation acts inside the user's live, logged-in sessions — the
  // same consequence Computer Use already gates for browser apps. Gate the
  // state-changing subset here so the cheaper mechanism is not the ungated one.
  // Approval is per conversation (like Computer Use's per-task grant): the user
  // approves once for the task, not once per click.
  {
    const consequence = classifyBrowserTool(name);
    if (consequence === 'state-changing') {
      const granted = hasBrowserGrant(toolContext?.conversationId);
      const decision = strategy.decideOtherTool(consequence, granted);
      if (decision !== 'allow') {
        if (!onRequireConfirmation) {
          // No confirmation channel (headless/background run) — fail closed
          // rather than silently acting in the user's session.
          return { decision: 'deny', reason: `Error: ${t.commandConfirm.browserDenied}` };
        }
        const confirmed = await onRequireConfirmation({
          command: `${t.commandConfirm.browserAction}: ${name}`,
          level: 'warn',
          reason: t.commandConfirm.browserReason,
          kind: 'browser',
        });
        if (!confirmed) {
          return { decision: 'deny', reason: t.commandConfirm.userCancelled };
        }
        grantBrowserAutomation(toolContext?.conversationId);
      }
    }
  }

  // Self-extension: creating a subagent, installing an MCP server, or
  // rewriting the persona all write durable state that shapes every later
  // turn. Skills already require a draft + content scan + audited history;
  // these took the same kind of write with no gate at all, so a single
  // injected instruction could buy a persistent foothold. No per-conversation
  // grant here — these are rare, deliberate acts, each worth its own ask.
  {
    const selfExtension = classifySelfExtension(name, input);
    if (selfExtension) {
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
        });
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
      const allowed = await showPolicyConfirm(policyCheck.reason ?? '此操作需要企业策略二次确认')
      if (!allowed) {
        return { decision: 'deny', reason: `Error: [policy] user declined confirmation` }
      }
    }
  }

  return { decision: 'allow' };
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
  // P1-3d-3: approval chain extracted to checkToolApproval — see its doc.
  // Behavior-preserving: same deny-reason strings, same order, same callbacks.
  const approval = await checkToolApproval(name, input, toolContext, onRequireConfirmation, onRequireFilePermission);
  if (approval.decision === 'deny') {
    return approval.reason ?? `Error: tool "${name}" was denied`;
  }

  // First check builtin tools. A Labs-gated-off tool stays in the registry but
  // is treated as absent here too, so a stale/hallucinated tool_use falls
  // through to the "Unknown tool" fail-safe instead of silently executing.
  if (toolRegistry.has(name) && !isToolGatedOff(name)) {
    const result = await toolRegistry.execute(name, input, toolContext);
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
      const result = await mcpManager.callTool(serverName, toolName, input);
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
