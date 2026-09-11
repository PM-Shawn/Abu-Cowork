import type { SubagentDefinition } from '@/types';
import { isBuiltinAgentPath } from '@/core/agent/builtinAgent';
import { agentRegistry, serializeAgentMd } from '@/core/agent/registry';
import { saveItemToAbuDir } from '@/utils/itemStorage';
import { isPluginOwnedAgent } from '@/utils/agentSource';

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

/** Builtin/marketplace agents can't carry frontmatter — their names are stable
 *  (shipped with the app), so a synthetic name-keyed id serves as the roleId.
 *  This is what lets 市场 roles join teams (user feedback 2026-08-31). */
export function isBuiltinAgent(agent: Pick<SubagentDefinition, 'filePath'>): boolean {
  return isBuiltinAgentPath(agent.filePath);
}

const BUILTIN_ROLE_PREFIX = 'builtin:';
/**
 * Plugin-contributed agents are the third id family. Their AGENT.md belongs to
 * the plugin: the installer's frontmatter allowlist has no `role-id`, so any
 * id written there is destroyed by the next plugin update or uninstall. Like
 * builtins, their name is stable within the plugin, so a name-keyed synthetic
 * id is the identity — nothing is ever written into the plugin's file.
 */
const PLUGIN_ROLE_PREFIX = 'plugin:';

/** Effective roleId for any agent — synthetic for builtins and plugin agents, frontmatter otherwise. */
export function effectiveRoleId(agent: SubagentDefinition): string | undefined {
  if (isBuiltinAgent(agent)) return BUILTIN_ROLE_PREFIX + agent.name;
  if (isPluginOwnedAgent(agent)) return PLUGIN_ROLE_PREFIX + agent.name;
  return agent.roleId;
}

/** Resolve a stored roleId back to the live agent (all three id families). */
export function resolveRoleId(roleId: string): SubagentDefinition | null {
  if (roleId.startsWith(BUILTIN_ROLE_PREFIX)) {
    const agent = agentRegistry.getAgent(roleId.slice(BUILTIN_ROLE_PREFIX.length));
    return agent && isBuiltinAgent(agent) ? agent : null;
  }
  if (roleId.startsWith(PLUGIN_ROLE_PREFIX)) {
    const agent = agentRegistry.getAgent(roleId.slice(PLUGIN_ROLE_PREFIX.length));
    return agent && isPluginOwnedAgent(agent) ? agent : null;
  }
  for (const meta of agentRegistry.getAvailableAgents()) {
    const agent = agentRegistry.getAgent(meta.name);
    if (agent?.roleId === roleId) return agent;
  }
  return null;
}


/**
 * Return the agent's stable roleId, writing one into its AGENT.md if missing.
 * Caller is responsible for refreshing the discovery store afterwards when a
 * write happened (returned `wrote` flag). Builtin and plugin-owned agents are
 * never written to — their identity is synthetic.
 */
export async function ensureRoleId(agent: SubagentDefinition): Promise<{ roleId: string; wrote: boolean }> {
  if (isBuiltinAgent(agent)) return { roleId: BUILTIN_ROLE_PREFIX + agent.name, wrote: false };
  if (isPluginOwnedAgent(agent)) return { roleId: PLUGIN_ROLE_PREFIX + agent.name, wrote: false };
  if (agent.roleId) return { roleId: agent.roleId, wrote: false };
  const roleId = createRoleId();
  const md = serializeAgentMd({ ...agent, roleId }, agent.systemPrompt ?? '');
  await saveItemToAbuDir('agents', 'AGENT.md', agent.name, md, agent.filePath);
  return { roleId, wrote: true };
}
