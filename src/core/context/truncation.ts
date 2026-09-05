/**
 * Tool Result Truncation — intelligent truncation by tool type
 *
 * Prevents context window overflow by truncating long tool results
 * while preserving the most useful information.
 */

import { TOOL_NAMES } from '../tools/toolNames';

interface TruncationRule {
  headLines: number;
  tailLines: number;
  maxChars: number;
}

const TRUNCATION_RULES: Record<string, TruncationRule> = {
  [TOOL_NAMES.READ_FILE]: { headLines: 150, tailLines: 20, maxChars: 15000 },
  [TOOL_NAMES.LIST_DIRECTORY]: { headLines: 100, tailLines: 0, maxChars: 8000 },
  [TOOL_NAMES.RUN_COMMAND]: { headLines: 150, tailLines: 30, maxChars: 15000 },
  [TOOL_NAMES.SEARCH_FILES]: { headLines: 50, tailLines: 0, maxChars: 8000 },
  [TOOL_NAMES.FIND_FILES]: { headLines: 100, tailLines: 0, maxChars: 8000 },
  [TOOL_NAMES.WEB_SEARCH]: { headLines: 0, tailLines: 0, maxChars: 8000 },
};

const DEFAULT_RULE: TruncationRule = { headLines: 0, tailLines: 0, maxChars: 3500 };

/**
 * Per-tool overrides for MCP servers, matched on the tool suffix of a
 * `server__tool` name.
 *
 * Why this exists: `TRUNCATION_RULES` is keyed by builtin tool names, so every
 * MCP tool — browser or otherwise — fell through to `DEFAULT_RULE` and had its
 * result cut at 3500 characters by character count. For a tool that returns
 * structured data that is not a size limit, it is corruption: the JSON stops
 * being parseable and the caller cannot tell what was dropped.
 *
 * These tools bound their own output at the source, with a message saying what
 * was cut and how to ask for less (see `takeSnapshot`'s truncation message).
 * The budget here only has to be wide enough not to re-cut that already-bounded
 * payload behind its back. Context pressure still scales it down, so a full
 * context window is not held open by one page read.
 */
const MCP_TOOL_RULES: Record<string, TruncationRule> = {
  snapshot: { headLines: 0, tailLines: 0, maxChars: 32000 },
  // `find` bounds its own payload to this exact number (`MAX_FIND_CHARS` in
  // `abu-chrome-extension/src/content/index.ts`) by binary search on the real
  // serialized size, so the character slicer below never gets to shred that
  // JSON. Changing this without changing that one re-opens the gap.
  find: { headLines: 0, tailLines: 0, maxChars: 16000 },
  query_js: { headLines: 0, tailLines: 0, maxChars: 32000 },
  extract_text: { headLines: 0, tailLines: 0, maxChars: 20000 },
  extract_table: { headLines: 0, tailLines: 0, maxChars: 20000 },
  get_tabs: { headLines: 0, tailLines: 0, maxChars: 8000 },
};

/** Servers whose tools are covered by `MCP_TOOL_RULES`. */
const BROWSER_MCP_SERVERS = new Set(['abu-browser', 'abu-browser-bridge']);

/**
 * Resolve the rule for a tool name, which may be a builtin name or a
 * namespaced `server__tool` MCP name.
 */
function resolveRule(toolName: string): TruncationRule {
  const builtin = TRUNCATION_RULES[toolName];
  if (builtin) return builtin;

  const separator = toolName.indexOf('__');
  if (separator !== -1 && BROWSER_MCP_SERVERS.has(toolName.slice(0, separator))) {
    const rule = MCP_TOOL_RULES[toolName.slice(separator + 2)];
    if (rule) return rule;
  }

  return DEFAULT_RULE;
}

/**
 * Scale factor for truncation limits based on context pressure.
 * Returns a multiplier (0.0–1.0) that shrinks the truncation budget
 * when context is tight.
 *
 * @param contextUsagePercent - 0-100, how full the context window is
 */
export function getContextPressureScale(contextUsagePercent?: number): number {
  if (contextUsagePercent === undefined) return 1.0;
  if (contextUsagePercent < 50) return 1.0;  // plenty of room
  if (contextUsagePercent < 70) return 0.7;  // moderate pressure
  if (contextUsagePercent < 85) return 0.4;  // high pressure
  return 0.25;                                // critical — aggressive truncation
}

/**
 * Truncate a tool result based on the tool type.
 *
 * @param toolName - Name of the tool that produced the result
 * @param result - Raw result string
 * @param contextUsagePercent - Optional context usage (0-100). When provided,
 *   truncation limits are scaled down under context pressure, keeping more room
 *   for conversation history.
 */
export function truncateToolResult(toolName: string, result: string, contextUsagePercent?: number): string {
  if (!result) return result;

  const baseRule = resolveRule(toolName);
  const scale = getContextPressureScale(contextUsagePercent);

  // Apply context pressure scaling
  const rule: TruncationRule = scale < 1.0
    ? {
      headLines: Math.max(20, Math.floor(baseRule.headLines * scale)),
      tailLines: Math.max(5, Math.floor(baseRule.tailLines * scale)),
      maxChars: Math.max(1500, Math.floor(baseRule.maxChars * scale)),
    }
    : baseRule;

  // If within char limit, no truncation needed
  if (result.length <= rule.maxChars) return result;

  // Line-based truncation for tools with line rules
  if (rule.headLines > 0) {
    const lines = result.split('\n');
    if (lines.length > rule.headLines + rule.tailLines + 1) {
      const head = lines.slice(0, rule.headLines);
      const tail = rule.tailLines > 0 ? lines.slice(-rule.tailLines) : [];
      const omitted = lines.length - rule.headLines - rule.tailLines;
      const truncated = [
        ...head,
        `\n[... ${omitted} lines omitted ...]\n`,
        ...tail,
      ].join('\n');

      // Further trim if still too long
      if (truncated.length > rule.maxChars) {
        return charTruncate(truncated, rule.maxChars);
      }
      return truncated;
    }
  }

  // Character-based truncation (default fallback)
  return charTruncate(result, rule.maxChars);
}

/**
 * Character-level truncation preserving head and tail
 */
function charTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const tailChars = Math.min(500, Math.floor(maxChars * 0.15));
  const headChars = maxChars - tailChars - 50; // 50 chars for omission message

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omitted = text.length - headChars - tailChars;

  return `${head}\n\n[... ${omitted} characters omitted ...]\n\n${tail}`;
}
