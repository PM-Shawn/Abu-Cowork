/**
 * Advanced Tool Filtering for Skills
 *
 * Supports pattern-based allowed-tools syntax:
 * - "read_file"                  → exact match
 * - "mcp__github__*"             → wildcard prefix match
 * - "run_command(npm run *)"     → tool name + command prefix match
 * - "write_file(/src/**)"        → tool name + path glob match
 * - "delegate_to_agent(coder)"   → tool name + argument restriction
 */

import { TOOL_NAMES } from '../tools/toolNames';

interface ParsedPattern {
  toolName: string;
  constraint?: string;   // The part inside parentheses
  isWildcard: boolean;   // toolName contains *
}

/**
 * Parse an allowed-tools pattern string into structured form.
 */
function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim();

  // Check for constraint syntax: toolName(constraint)
  const parenMatch = trimmed.match(/^([^(]+)\((.+)\)$/);
  if (parenMatch) {
    return {
      toolName: parenMatch[1].trim(),
      constraint: parenMatch[2].trim(),
      isWildcard: parenMatch[1].includes('*'),
    };
  }

  return {
    toolName: trimmed,
    constraint: undefined,
    isWildcard: trimmed.includes('*'),
  };
}

/**
 * Check if a string matches a glob-like pattern with * wildcards.
 * Only supports * (match any characters) — not full glob.
 * Exported for reuse in skillHooks.ts.
 */
export function matchWildcard(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value === pattern;

  // Convert glob pattern to regex
  const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr).test(value);
}

/**
 * Check if a tool name matches an allowed-tools pattern.
 * Only checks the tool name part (no input validation).
 */
export function matchesToolName(toolName: string, pattern: string): boolean {
  const parsed = parsePattern(pattern);
  return matchWildcard(toolName, parsed.toolName);
}

/**
 * Check if a tool call (name + input) matches an allowed-tools pattern.
 * For patterns with constraints, validates the tool input against the constraint.
 */
export function matchesToolPattern(
  toolName: string,
  pattern: string,
  toolInput?: Record<string, unknown>,
): boolean {
  const parsed = parsePattern(pattern);

  // Step 1: Check tool name match
  if (!matchWildcard(toolName, parsed.toolName)) return false;

  // Step 2: If no constraint, name match is sufficient
  if (!parsed.constraint) return true;

  // Step 3: Validate constraint against tool input
  if (!toolInput) return false;

  return validateConstraint(toolName, parsed.constraint, toolInput);
}

/**
 * Validate a tool's input against a constraint string.
 * Heuristic mapping based on known tool types:
 * - run_command → check `command` field against prefix pattern
 * - write_file/edit_file/read_file → check `path` field against glob
 * - delegate_to_agent → check `agent_name` field
 * - Other tools → check first string field value
 */
function validateConstraint(
  toolName: string,
  constraint: string,
  input: Record<string, unknown>,
): boolean {
  // Determine which input field to check based on tool name
  let fieldValue: string | undefined;

  if (toolName === TOOL_NAMES.RUN_COMMAND) {
    fieldValue = input.command as string | undefined;
  } else if (([TOOL_NAMES.READ_FILE, TOOL_NAMES.WRITE_FILE, TOOL_NAMES.EDIT_FILE, TOOL_NAMES.LIST_DIRECTORY] as string[]).includes(toolName)) {
    fieldValue = input.path as string | undefined;
  } else if (toolName === TOOL_NAMES.DELEGATE_TO_AGENT) {
    fieldValue = input.agent_name as string | undefined;
  } else if (toolName === TOOL_NAMES.USE_SKILL) {
    fieldValue = input.skill_name as string | undefined;
  } else {
    // Generic: check first string value in input
    for (const v of Object.values(input)) {
      if (typeof v === 'string') {
        fieldValue = v;
        break;
      }
    }
  }

  if (fieldValue === undefined) return false;

  // Check for domain: prefix (e.g., "domain:github.com")
  if (constraint.startsWith('domain:')) {
    const domain = constraint.slice(7);
    try {
      const url = new URL(fieldValue);
      return url.hostname === domain || url.hostname.endsWith('.' + domain);
    } catch {
      return fieldValue.includes(domain);
    }
  }

  // Default: wildcard match
  return matchWildcard(fieldValue, constraint);
}

/**
 * Parse an allowed-tools list into:
 * 1. A set of tool names that should be included (for tool definition filtering)
 * 2. A map of runtime input validators (for execution-time constraint checking)
 */
export function parseToolPatterns(patterns: string[]): {
  allowedToolNames: Set<string>;
  inputValidators: Map<string, (input: Record<string, unknown>) => boolean>;
} {
  const allowedToolNames = new Set<string>();
  const inputValidators = new Map<string, (input: Record<string, unknown>) => boolean>();

  for (const pattern of patterns) {
    const parsed = parsePattern(pattern);

    // For wildcard patterns, we can't pre-enumerate tool names
    // The caller must do runtime matching
    if (parsed.isWildcard) {
      // Store the pattern as-is — caller will use matchesToolName at runtime
      allowedToolNames.add(pattern);
    } else {
      allowedToolNames.add(parsed.toolName);
    }

    // If there's a constraint, create a runtime validator
    if (parsed.constraint) {
      const constraint = parsed.constraint;
      const tName = parsed.toolName;
      inputValidators.set(tName, (input: Record<string, unknown>) =>
        validateConstraint(tName, constraint, input),
      );
    }
  }

  return { allowedToolNames, inputValidators };
}

/**
 * Filter tools based on allowed-tools patterns.
 * Handles both exact matches and wildcard patterns.
 */
export function filterToolsByPatterns(
  toolNames: string[],
  patterns: string[],
): string[] {
  return toolNames.filter(name =>
    patterns.some(pattern => matchesToolName(name, pattern)),
  );
}
