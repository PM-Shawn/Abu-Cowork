import type { ToolDefinition } from '../../types';
import { matchesToolPattern } from '../skill/toolFilter';
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

/**
 * Protocol tools every subagent must see regardless of the agent's declared
 * `tools:` allowlist. Marketplace/builtin agents ship frozen tool lists that
 * predate newer protocol tools — team_propose_plan is how a team leader
 * reports its split during a planning run, and it is context-gated (only a
 * registered planning conversation accepts it), so exposure elsewhere is
 * inert. An explicit agent `disallowed-tools` entry still removes it.
 */
const ALWAYS_AVAILABLE_SUBAGENT_TOOLS = new Set<string>([
  'team_propose_plan',
]);

/** Protocol tools every subagent may call regardless of its declared list. */
export function isProtocolSubagentTool(toolName: string): boolean {
  return ALWAYS_AVAILABLE_SUBAGENT_TOOLS.has(toolName);
}

/**
 * Dispatch-time boundary for a tool_use the model actually emitted.
 *
 * Name-level roster filtering (resolveSubagentToolNames) cannot express input
 * constraints such as run_command(npm run *), so the loop re-checks the
 * agent's declared `tools:` and the run's allowedTools against the concrete
 * input right before executing — and again after a preToolCall hook may have
 * rewritten it. Both re-checks MUST apply the same protocol-tool exemption the
 * roster applies, or a builtin/marketplace agent with a frozen tools list is
 * offered team_propose_plan and then refused when it calls it (real-machine
 * bug 2026-09-03: the leader fell back to asking for manual confirmation).
 *
 * Returns the error string to hand back as the tool result, or null when the
 * call is within bounds.
 */
export function checkDispatchToolBoundary(
  agentTools: string[] | undefined,
  allowedTools: string[] | undefined,
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  if (isProtocolSubagentTool(toolName)) return null;
  if (agentTools?.length && !agentTools.some((pattern) => matchesToolPattern(toolName, pattern, input))) {
    return `Error: tool "${toolName}" input is outside this agent's fixed tool boundary`;
  }
  if (allowedTools?.length && !allowedTools.some((pattern) => matchesToolPattern(toolName, pattern, input))) {
    return `Error: tool "${toolName}" is not allowed for this agent run`;
  }
  return null;
}

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
      ((declared.patterns.length === 0 || declared.patterns.some((pattern) => matchesToolName(toolName, pattern)))
        || ALWAYS_AVAILABLE_SUBAGENT_TOOLS.has(toolName))
      && !disallowed.patterns.some((pattern) => matchesToolName(toolName, pattern))
      && (!allowedTools?.length || allowedTools.some((pattern) => matchesToolName(toolName, pattern)) || ALWAYS_AVAILABLE_SUBAGENT_TOOLS.has(toolName))
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
