import type { SubagentDefinition } from '@/types';
import { serializeAgentMd } from '@/core/agent/registry';
import { saveItemToAbuDir } from '@/utils/itemStorage';

/**
 * Stable role identity for team membership (PRD docs/abu-team-prd-v2.md §2).
 *
 * Teams reference members by roleId, not by name, so renaming an agent never
 * breaks its team memberships. The id is written into AGENT.md frontmatter
 * (`role-id`) the first time an agent joins a team — write-once, never rotated.
 * Salvaged design from the v1 spike (d1811535).
 */

export function createRoleId(): string {
  return `role-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Return the agent's stable roleId, writing one into its AGENT.md if missing.
 * Caller is responsible for refreshing the discovery store afterwards when a
 * write happened (returned `wrote` flag).
 */
export async function ensureRoleId(agent: SubagentDefinition): Promise<{ roleId: string; wrote: boolean }> {
  if (agent.roleId) return { roleId: agent.roleId, wrote: false };
  const roleId = createRoleId();
  const md = serializeAgentMd({ ...agent, roleId }, agent.systemPrompt ?? '');
  await saveItemToAbuDir('agents', 'AGENT.md', agent.name, md, agent.filePath);
  return { roleId, wrote: true };
}
