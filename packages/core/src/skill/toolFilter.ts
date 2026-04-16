/**
 * 对比 Abu 原版改动：
 * - 原版 import `../tools/toolNames` 常量；
 * - core 的 tools 模块尚未迁移，POC 内联常量。tools 迁移后再统一。
 */

const TOOL_RUN_COMMAND = 'run_command';
const TOOL_READ_FILE = 'read_file';
const TOOL_WRITE_FILE = 'write_file';
const TOOL_EDIT_FILE = 'edit_file';
const TOOL_LIST_DIRECTORY = 'list_directory';
const TOOL_DELEGATE_TO_AGENT = 'delegate_to_agent';
const TOOL_USE_SKILL = 'use_skill';

interface ParsedPattern {
  toolName: string;
  constraint?: string;
  isWildcard: boolean;
}

function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim();
  const parenMatch = trimmed.match(/^([^(]+)\((.+)\)$/);
  if (parenMatch) {
    return {
      toolName: parenMatch[1].trim(),
      constraint: parenMatch[2].trim(),
      isWildcard: parenMatch[1].includes('*'),
    };
  }
  return { toolName: trimmed, constraint: undefined, isWildcard: trimmed.includes('*') };
}

export function matchWildcard(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value === pattern;
  const regexStr =
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr).test(value);
}

export function matchesToolName(toolName: string, pattern: string): boolean {
  const parsed = parsePattern(pattern);
  return matchWildcard(toolName, parsed.toolName);
}

export function matchesToolPattern(
  toolName: string,
  pattern: string,
  toolInput?: Record<string, unknown>
): boolean {
  const parsed = parsePattern(pattern);
  if (!matchWildcard(toolName, parsed.toolName)) return false;
  if (!parsed.constraint) return true;
  if (!toolInput) return false;
  return validateConstraint(toolName, parsed.constraint, toolInput);
}

function validateConstraint(
  toolName: string,
  constraint: string,
  input: Record<string, unknown>
): boolean {
  let fieldValue: string | undefined;

  if (toolName === TOOL_RUN_COMMAND) {
    fieldValue = input.command as string | undefined;
  } else if (
    ([TOOL_READ_FILE, TOOL_WRITE_FILE, TOOL_EDIT_FILE, TOOL_LIST_DIRECTORY] as string[]).includes(
      toolName
    )
  ) {
    fieldValue = input.path as string | undefined;
  } else if (toolName === TOOL_DELEGATE_TO_AGENT) {
    fieldValue = input.agent_name as string | undefined;
  } else if (toolName === TOOL_USE_SKILL) {
    fieldValue = input.skill_name as string | undefined;
  } else {
    for (const v of Object.values(input)) {
      if (typeof v === 'string') {
        fieldValue = v;
        break;
      }
    }
  }

  if (fieldValue === undefined) return false;

  if (constraint.startsWith('domain:')) {
    const domain = constraint.slice(7);
    try {
      const url = new URL(fieldValue);
      return url.hostname === domain || url.hostname.endsWith('.' + domain);
    } catch {
      return fieldValue.includes(domain);
    }
  }

  return matchWildcard(fieldValue, constraint);
}

export function parseToolPatterns(patterns: string[]): {
  allowedToolNames: Set<string>;
  inputValidators: Map<string, (input: Record<string, unknown>) => boolean>;
} {
  const allowedToolNames = new Set<string>();
  const inputValidators = new Map<string, (input: Record<string, unknown>) => boolean>();

  for (const pattern of patterns) {
    const parsed = parsePattern(pattern);
    if (parsed.isWildcard) {
      allowedToolNames.add(pattern);
    } else {
      allowedToolNames.add(parsed.toolName);
    }
    if (parsed.constraint) {
      const constraint = parsed.constraint;
      const tName = parsed.toolName;
      inputValidators.set(tName, (input) => validateConstraint(tName, constraint, input));
    }
  }

  return { allowedToolNames, inputValidators };
}

export function filterToolsByPatterns(toolNames: string[], patterns: string[]): string[] {
  return toolNames.filter((name) => patterns.some((p) => matchesToolName(name, p)));
}
