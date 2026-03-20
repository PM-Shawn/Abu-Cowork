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
 * Truncate a tool result based on the tool type
 */
export function truncateToolResult(toolName: string, result: string): string {
  if (!result) return result;

  const rule = TRUNCATION_RULES[toolName] || DEFAULT_RULE;

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
