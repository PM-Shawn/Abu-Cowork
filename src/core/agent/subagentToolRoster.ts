import type { ToolDefinition } from '../../types';
import { matchesToolPattern } from '../skill/toolFilter';
import { matchesToolName } from '../skill/toolFilter';
import { TOOL_NAMES } from '../tools/toolNames';
import { checkAgentToolCall, resolveAgentToolNames, type AgentToolResolution } from '@/core/agent/agentToolPolicy';

export type AgentToolMetadata = {
  tools?: unknown;
  disallowedTools?: unknown;
};

export type SubagentToolRosterResolution = AgentToolResolution;

const ALWAYS_BLOCKED_SUBAGENT_TOOLS = new Set<string>([
  TOOL_NAMES.DELEGATE_TO_AGENT,
  TOOL_NAMES.RUN_AGENT_BATCH,
  TOOL_NAMES.UPDATE_SOUL,
  TOOL_NAMES.ASK_USER_QUESTION,
  // System configuration. Everything below writes durable state that outlives
  // the single hand-off a member was dispatched for — an expert, team, skill,
  // plugin, scheduled task, trigger, file watch or connector server the user
  // then lives with. The three automation managers are exactly the set
  // permissions/selfExtensionPolicy.ts classifies together, so the two lists
  // cannot drift apart. Creating and editing any of this stays with Abu and a
  // team leader, both of which run as a `route.type === 'agent'` route
  // resolved by agentToolPolicy.ts and never by this file, so this list cannot
  // reach them.
  TOOL_NAMES.MANAGE_SCHEDULED_TASK,
  TOOL_NAMES.MANAGE_TRIGGER,
  TOOL_NAMES.MANAGE_FILE_WATCH,
  TOOL_NAMES.MANAGE_MCP_SERVER,
  TOOL_NAMES.SAVE_AGENT,
  TOOL_NAMES.SAVE_TEAM,
  TOOL_NAMES.SKILL_MANAGE,
  TOOL_NAMES.PLUGIN_PREPARE,
]);

/** Members have no harness-granted protocol tools. */
const SUBAGENT_PROTOCOL_TOOLS: readonly string[] = [];

/**
 * Dispatch-time boundary for a tool_use the model actually emitted.
 *
 * Name-level roster filtering (resolveSubagentToolNames) cannot express input
 * constraints such as run_command(npm run *), so the loop re-checks the
 * agent's role policy and the run's allowedTools against the concrete
 * input right before executing — and again after a preToolCall hook may have
 * rewritten it. Role policy success never skips the task restriction.
 *
 * Returns the error string to hand back as the tool result, or null when the
 * call is within bounds.
 */
export function checkDispatchToolBoundary(
  agent: AgentToolMetadata,
  allowedTools: string[] | undefined,
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  const roleError = checkAgentToolCall({ ...agent, protocolTools: SUBAGENT_PROTOCOL_TOOLS }, toolName, input);
  if (roleError) return roleError;
  if (allowedTools?.length && !allowedTools.some((pattern) => matchesToolPattern(toolName, pattern, input))) {
    return `Error: tool "${toolName}" is not allowed for this agent run`;
  }
  return null;
}

/** Pure, shared name-level roster resolver for runtime, sidecar shell and UI. */
export function resolveSubagentToolNames(
  allToolNames: readonly string[],
  agent: AgentToolMetadata,
  allowedTools?: readonly string[],
  blockedTools?: readonly string[],
): SubagentToolRosterResolution {
  const resolution = resolveAgentToolNames(allToolNames, { ...agent, protocolTools: SUBAGENT_PROTOCOL_TOOLS });
  if (resolution.invalidField) return resolution;

  return {
    toolNames: resolution.toolNames.filter((toolName) =>
      // Optional task patterns retain their existing empty-means-unrestricted
      // semantics; exact frozen task snapshots are enforced by their callers.
      (!allowedTools?.length || allowedTools.some((pattern) => matchesToolName(toolName, pattern)))
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
