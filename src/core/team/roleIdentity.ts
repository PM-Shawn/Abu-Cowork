import type { SubagentDefinition } from '@/types';
import { isBuiltinAgentPath } from '@/core/agent/builtinAgent';
import { agentRegistry, serializeAgentMd } from '@/core/agent/registry';
import { saveItemToAbuDir } from '@/utils/itemStorage';
import { isPluginOwnedAgent } from '@/utils/agentSource';
import { pluginActivationRecordsReady, pluginOwnerForAgent } from '@/core/plugin/activationPolicy';

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

/**
 * Does a plugin own this agent's AGENT.md, for identity purposes?
 *
 * The authority is the plugin activation records (`pluginOwnerForAgent`, the
 * same ownership the execution gate `isPluginAgentAllowed` enforces). They are
 * the persisted ownership derived from `installed.json` — which agent files
 * each plugin contributed — and pluginStore keeps the last good records when a
 * later read fails, so a broken manifest never turns a plugin file into a
 * user file. A file claimed by more than one plugin fails closed: it is still
 * plugin-managed and must never be written. A file no record claims, once the
 * records are ready, is independent (an orphan left after uninstall, or a
 * user's hand-written `source:`), matching how AgentsSection treats it.
 *
 * Cold start: until the records have been read, the frontmatter `source:` —
 * the installer's cache of the answer — decides.
 *
 * Not discovery metadata: its non-strict refresh reads the manifest with
 * `readInstalledPluginsSafely`, which yields `[]` on any failure, and then
 * strips `source` from every agent — which would make plugin files writable.
 */
function isPluginManagedAgent(agent: SubagentDefinition): boolean {
  if (pluginOwnerForAgent(agent) !== undefined) return true; // an owner key, or null for a conflict
  // Startup invariant: activationPolicy's `ready` starts out TRUE. That is safe
  // only because pluginStore's persist hydrate (synchronous localStorage) runs
  // at import and publishes the persisted records with `recordsReady=false`.
  // If that hydrate ever becomes async or pluginStore is imported lazily, this
  // line would treat every plugin file as a user file at startup — and
  // ensureRoleId would write into it. (Today's gap: an unparseable persisted
  // entry makes zustand skip the callback, leaving `ready` true until the next
  // pluginStore update — bootstrapPluginUpdates' first statement.)
  if (pluginActivationRecordsReady()) return false;
  return isPluginOwnedAgent(agent);
}

/** Effective roleId for any agent — synthetic for builtins and plugin agents, frontmatter otherwise. */
export function effectiveRoleId(agent: SubagentDefinition): string | undefined {
  if (isBuiltinAgent(agent)) return BUILTIN_ROLE_PREFIX + agent.name;
  if (isPluginManagedAgent(agent)) return PLUGIN_ROLE_PREFIX + agent.name;
  return agent.roleId;
}

/**
 * The agent name a name-keyed roleId (`builtin:` / `plugin:`) spells out, even
 * when that agent is gone — for labelling a member that no longer resolves.
 * Frontmatter `role-…` ids carry no name: undefined.
 */
export function roleIdAgentName(roleId: string): string | undefined {
  for (const prefix of [BUILTIN_ROLE_PREFIX, PLUGIN_ROLE_PREFIX]) {
    if (roleId.startsWith(prefix)) return roleId.slice(prefix.length) || undefined;
  }
  return undefined;
}

/** Resolve a stored roleId back to the live agent (all three id families). */
export function resolveRoleId(roleId: string): SubagentDefinition | null {
  if (roleId.startsWith(BUILTIN_ROLE_PREFIX)) {
    const agent = agentRegistry.getAgent(roleId.slice(BUILTIN_ROLE_PREFIX.length));
    return agent && isBuiltinAgent(agent) ? agent : null;
  }
  if (roleId.startsWith(PLUGIN_ROLE_PREFIX)) {
    const agent = agentRegistry.getAgent(roleId.slice(PLUGIN_ROLE_PREFIX.length));
    return agent && isPluginManagedAgent(agent) ? agent : null;
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
  if (isPluginManagedAgent(agent)) return { roleId: PLUGIN_ROLE_PREFIX + agent.name, wrote: false };
  if (agent.roleId) return { roleId: agent.roleId, wrote: false };
  const roleId = createRoleId();
  const md = serializeAgentMd({ ...agent, roleId }, agent.systemPrompt ?? '');
  await saveItemToAbuDir('agents', 'AGENT.md', agent.name, md, agent.filePath);
  return { roleId, wrote: true };
}
