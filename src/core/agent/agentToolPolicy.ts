import { matchesToolName, matchesToolPattern } from '@/core/skill/toolFilter';

export interface AgentToolPolicy {
  tools?: unknown;
  disallowedTools?: unknown;
  /** Trusted harness names that bypass only the role allowlist. */
  protocolTools: readonly string[];
}

export interface AgentToolResolution {
  toolNames: string[];
  invalidField?: 'tools' | 'disallowedTools';
}

function parsePatterns(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) return null;
  return value.map((entry) => entry.trim());
}

function parsePolicy(policy: AgentToolPolicy):
  | { allowed: string[]; denied: string[] }
  | { invalidField: 'tools' | 'disallowedTools' } {
  const allowed = parsePatterns(policy.tools);
  if (allowed === null) return { invalidField: 'tools' };
  const denied = parsePatterns(policy.disallowedTools);
  if (denied === null) return { invalidField: 'disallowedTools' };
  return { allowed, denied };
}

/** Resolve only role policy; callers still apply runtime and task boundaries. */
export function resolveAgentToolNames(
  names: readonly string[],
  policy: AgentToolPolicy,
): AgentToolResolution {
  const parsed = parsePolicy(policy);
  if ('invalidField' in parsed) return { toolNames: [], invalidField: parsed.invalidField };
  return {
    toolNames: names.filter((name) =>
      (parsed.allowed.length === 0
        || policy.protocolTools.includes(name)
        || parsed.allowed.some((pattern) => matchesToolName(name, pattern)))
      && !parsed.denied.some((pattern) => matchesToolName(name, pattern)),
    ),
  };
}

/** Check concrete inputs before execution and after hooks rewrite them. */
export function checkAgentToolCall(
  policy: AgentToolPolicy,
  name: string,
  input: Record<string, unknown> | undefined,
): string | null {
  const parsed = parsePolicy(policy);
  if ('invalidField' in parsed) {
    return `Error: tool "${name}" is outside this agent's fixed tool boundary: invalid ${parsed.invalidField} metadata`;
  }
  // Deny is name-level, matching roster filtering, even for constrained entries.
  if (parsed.denied.some((pattern) => matchesToolName(name, pattern))) {
    return `Error: tool "${name}" is outside this agent's fixed tool boundary`;
  }
  if (parsed.allowed.length > 0
    && !policy.protocolTools.includes(name)
    && !parsed.allowed.some((pattern) => matchesToolPattern(name, pattern, input))) {
    return `Error: tool "${name}" input is outside this agent's fixed tool boundary`;
  }
  // Success here says nothing about the caller's frozen roster or task ceiling.
  return null;
}
