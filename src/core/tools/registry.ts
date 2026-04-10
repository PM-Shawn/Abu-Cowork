import type { ToolDefinition, ToolResult, ToolResultContent, ToolExecutionContext } from '../../types';
import { mcpManager } from '../mcp/client';
import { analyzeCommand, type ConfirmationInfo, type DangerLevel } from './commandSafety';
import { checkReadPath, checkWritePath, checkListPath, authorizeWorkspace } from './pathSafety';
import { isWindows } from '../../utils/platform';
import { getI18n } from '../../i18n';
import { truncateToolResult } from '../context/truncation';
import { useSettingsStore } from '../../stores/settingsStore';
import { getPermissionStrategy } from '../permissions/permissionMode';
import { TOOL_NAMES } from './toolNames';

/**
 * Extract text-only representation from a ToolResult.
 * For string results, returns as-is. For rich content arrays, extracts text blocks.
 */
export function toolResultToString(result: ToolResult): string {
  if (typeof result === 'string') return result;
  return result
    .filter((c): c is Extract<ToolResultContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n') || '[image]';
}

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
 * Playwright browser tools that overlap with abu-browser-bridge.
 * When abu-browser-bridge is connected, these are filtered out to avoid
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
 * Filters out conflicting playwright browser tools when abu-browser-bridge is connected
 */
export function getAllTools(): ToolDefinition[] {
  const builtinTools = toolRegistry.getAll();
  const mcpTools = mcpManager.listTools();
  const toolMap = new Map<string, ToolDefinition>();

  // Check if abu-browser-bridge is connected — if so, filter out playwright browser tools
  const hasBrowserBridge = mcpManager.isConnected('abu-browser-bridge');

  // Computer use tools are always registered — the tool itself handles
  // auto-enabling and permission checks when first called.

  // Builtin tools first (higher priority)
  for (const tool of builtinTools) {
    toolMap.set(tool.name, tool);
  }
  // MCP tools — only add if no name conflict
  for (const tool of mcpTools) {
    if (!toolMap.has(tool.name)) {
      // Skip playwright browser tools when abu-browser-bridge is active
      if (hasBrowserBridge && PLAYWRIGHT_BROWSER_TOOLS.has(tool.name)) {
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
const FILE_TOOL_PATH_MAP: Record<string, (input: Record<string, unknown>) => { path: string; capability: 'read' | 'write' } | null> = {
  [TOOL_NAMES.READ_FILE]:      (i) => i.path ? { path: i.path as string, capability: 'read' } : null,
  [TOOL_NAMES.LIST_DIRECTORY]: (i) => i.path ? { path: i.path as string, capability: 'read' } : null,
  [TOOL_NAMES.WRITE_FILE]:     (i) => i.path ? { path: i.path as string, capability: 'write' } : null,
  [TOOL_NAMES.EDIT_FILE]:      (i) => i.path ? { path: i.path as string, capability: 'write' } : null,
  [TOOL_NAMES.SEARCH_FILES]:   (i) => i.path ? { path: i.path as string, capability: 'read' } : null,
  [TOOL_NAMES.FIND_FILES]:     (i) => i.path ? { path: i.path as string, capability: 'read' } : null,
};

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
  const t = getI18n();
  const permissionMode = useSettingsStore.getState().permissionMode;
  const strategy = getPermissionStrategy(permissionMode);

  // Safety check for run_command tool
  if (name === TOOL_NAMES.RUN_COMMAND) {
    const command = input.command as string;
    if (command) {
      const analysis = analyzeCommand(command);

      // Block dangerous commands — always enforced regardless of permission mode
      if (analysis.level === 'block') {
        return `Error: ${t.commandConfirm.blocked}: ${analysis.reason}`;
      }

      // Check if confirmation is needed based on permission mode
      const needsConfirm = strategy.shouldConfirmCommand(
        { command, level: analysis.level, reason: analysis.reason },
        analysis.readOnly,
      );
      if (needsConfirm && onRequireConfirmation) {
        const confirmed = await onRequireConfirmation({
          command,
          level: analysis.level,
          reason: analysis.reason,
        });
        if (!confirmed) {
          return t.commandConfirm.userCancelled;
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
          // Check if confirmation is needed based on permission mode
          const needsFileConfirm = strategy.shouldConfirmFileAccess(
            pathCheck.capability || pathInfo.capability,
            true,
          );
          if (needsFileConfirm) {
            // Needs user permission — ask via callback
            if (onRequireFilePermission) {
              const granted = await onRequireFilePermission({
                path: pathCheck.permissionPath,
                capability: pathCheck.capability || pathInfo.capability,
                toolName: name,
              });
              if (!granted) {
                return `[${t.toolErrors.userDeniedAccess} ${pathCheck.permissionPath}]`;
              }
              // Permission granted — re-check (should now pass since authorizeWorkspace was called)
              const recheck = await checkFn(pathInfo.path);
              if (!recheck.allowed) {
                return `Error: ${recheck.reason || t.toolErrors.pathAccessDenied}`;
              }
            } else {
              // No callback available (shouldn't happen in normal flow)
              return `Error: ${t.toolErrors.needsAuthorization} ${pathCheck.permissionPath}`;
            }
          } else {
            // Auto mode: auto-authorize the workspace for this path
            authorizeWorkspace(pathCheck.permissionPath);
          }
        } else {
          // Hard blocked — always enforced regardless of permission mode
          return `Error: ${pathCheck.reason}`;
        }
      }
    }
  }

  // First check builtin tools
  if (toolRegistry.has(name)) {
    const result = await toolRegistry.execute(name, input, toolContext);
    // Only truncate string results; rich content (images) passes through
    if (typeof result === 'string') {
      // Detect OS-level permission errors for file tools and add guidance
      if (isFileToolName(name) && isOSPermissionError(result)) {
        return formatOSPermissionGuide(result);
      }
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

function isFileToolName(name: string): boolean {
  return name in FILE_TOOL_PATH_MAP;
}

function isOSPermissionError(result: string): boolean {
  return /operation not permitted|EACCES|EPERM|access is denied/i.test(result);
}

function formatOSPermissionGuide(originalError: string): string {
  if (isWindows()) {
    return `${originalError}\n\n系统未授权阿布访问此位置。请以管理员身份运行 Abu，或检查文件夹权限设置。`;
  }
  return `${originalError}\n\nmacOS 系统未授权阿布访问此位置。请前往「系统设置 → 隐私与安全性 → 文件和文件夹」中授权 Abu，然后重启 Abu。`;
}

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
