import type { ToolDefinition } from '../../types';
import { matchesToolName } from '../skill/toolFilter';
import { TOOL_NAMES } from '../tools/toolNames';

export type AgentToolMetadata = {
  tools?: unknown;
  disallowedTools?: unknown;
};

export type SubagentToolRosterResolution = {
  toolNames: string[];
  invalidField?: 'tools' | 'disallowedTools';
};

const ALWAYS_BLOCKED_SUBAGENT_TOOLS = new Set<string>([
  TOOL_NAMES.DELEGATE_TO_AGENT,
  TOOL_NAMES.RUN_AGENT_BATCH,
  TOOL_NAMES.UPDATE_SOUL,
  TOOL_NAMES.ASK_USER_QUESTION,
]);

function parsePatterns(value: unknown): { patterns: string[]; valid: boolean } {
  if (value === undefined) return { patterns: [], valid: true };
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    return { patterns: [], valid: false };
  }
  return {
    patterns: value.map((entry) => entry.trim()).filter(Boolean),
    valid: true,
  };
}

/** Pure, shared name-level roster resolver for runtime, sidecar shell and UI. */
export function resolveSubagentToolNames(
  allToolNames: readonly string[],
  agent: AgentToolMetadata,
  allowedTools?: readonly string[],
  blockedTools?: readonly string[],
): SubagentToolRosterResolution {
  const declared = parsePatterns(agent.tools);
  if (!declared.valid) return { toolNames: [], invalidField: 'tools' };
  const disallowed = parsePatterns(agent.disallowedTools);
  if (!disallowed.valid) return { toolNames: [], invalidField: 'disallowedTools' };

  return {
    toolNames: allToolNames.filter((toolName) =>
      (declared.patterns.length === 0 || declared.patterns.some((pattern) => matchesToolName(toolName, pattern)))
      && !disallowed.patterns.some((pattern) => matchesToolName(toolName, pattern))
      && (!allowedTools?.length || allowedTools.some((pattern) => matchesToolName(toolName, pattern)))
      && !blockedTools?.some((pattern) => matchesToolName(toolName, pattern))
      && !ALWAYS_BLOCKED_SUBAGENT_TOOLS.has(toolName),
    ),
  };
}

export function resolveSubagentToolRoster(
  allTools: readonly ToolDefinition[],
  agent: AgentToolMetadata,
  allowedTools?: readonly string[],
  blockedTools?: readonly string[],
): ToolDefinition[] {
  const resolution = resolveSubagentToolNames(
    allTools.map((tool) => tool.name),
    agent,
    allowedTools,
    blockedTools,
  );
  const allowedNames = new Set(resolution.toolNames);
  return allTools.filter((tool) => allowedNames.has(tool.name));
}
