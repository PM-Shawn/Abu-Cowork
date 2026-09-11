import { matchesToolName } from '@/core/skill/toolFilter';
import { resolveSubagentToolNames } from '@/core/agent/subagentToolRoster';

/** Parse the comma-separated form fields used by AGENT.md tool metadata. */
export function parseAgentToolPatterns(value: string): string[] {
  return value.split(',').map((pattern) => pattern.trim()).filter(Boolean);
}

/**
 * Return declared patterns that do not currently match the live tool roster.
 * This deliberately shares the runtime wildcard semantics used by subagents.
 */
export function getUnmatchedAgentToolPatterns(
  value: string,
  knownToolNames: readonly string[],
): string[] {
  return parseAgentToolPatterns(value).filter(
    (pattern) => !knownToolNames.some((toolName) => matchesToolName(toolName, pattern)),
  );
}

export function getAgentToolSummary(
  tools: readonly string[] | undefined,
  disallowedTools: readonly string[] | undefined,
  knownToolNames: readonly string[],
): {
  isUnrestricted: boolean;
  toolNames: string[];
  invalidField?: 'tools' | 'disallowedTools';
} {
  const resolved = resolveSubagentToolNames(knownToolNames, { tools, disallowedTools });
  const allowedPatterns = Array.isArray(tools) ? tools.filter((pattern) => typeof pattern === 'string' && pattern.trim()) : [];
  const blockedPatterns = Array.isArray(disallowedTools)
    ? disallowedTools.filter((pattern) => typeof pattern === 'string' && pattern.trim())
    : [];
  return {
    isUnrestricted: resolved.invalidField === undefined
      && allowedPatterns.length === 0
      && blockedPatterns.length === 0,
    toolNames: resolved.toolNames,
    ...(resolved.invalidField ? { invalidField: resolved.invalidField } : {}),
  };
}
