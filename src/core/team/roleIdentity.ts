import type { SubagentDefinition } from '@/types';
import { isBuiltinAgentPath } from '@/core/agent/builtinAgent';
import { agentRegistry, serializeAgentMd } from '@/core/agent/registry';
import { saveItemToAbuDir } from '@/utils/itemStorage';
import { isPluginOwnedAgent } from '@/utils/agentSource';
import { PLUGIN_ROOT_DIRNAME } from '@/core/plugin/paths';

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

/** `…/.abu/plugin-packages/…` — the install root is named by
 *  `PLUGIN_ROOT_DIRNAME` (src/core/plugin/paths.ts, the one constant the whole
 *  plugin layer builds its paths from). Matched as a fragment rather than via
 *  `pluginRoot(home)` because nothing here knows the home directory; paths in
 *  this repo are normalised to `/` (src/utils/pathUtils.ts). Same idiom as
 *  `isSkillAllowedIn` (src/core/plugin/activationPolicy.ts). */
function isUnderPluginPackages(filePath: string | undefined): boolean {
  return !!filePath && filePath.includes(`/.abu/${PLUGIN_ROOT_DIRNAME}/`);
}

/**
 * Does a plugin own this agent's AGENT.md, for identity purposes?
 *
 * `isPluginOwnedAgent` reads the frontmatter `source:` key, which is a *cache*,
 * not the authority: the installer writes it and the discovery store backfills
 * it from `installed.json` (`applyPluginAgentSources`,
 * src/stores/discoveryStore.ts), but that backfill only reaches discovery
 * metadata — `agentRegistry.getAgent`, which this module reads, still sees the
 * raw frontmatter.
 *
 * KNOWN GAP: the path check does NOT close the "plugin agent with no `source:`"
 * case today. The installer materialises plugin agents into
 * `~/.abu/agents/<name>/` (src/core/agent/installer.ts) and the registry never
 * scans the plugin-packages root, so no agent this module can see has a path
 * under it. The check is kept because it cannot misclassify a user agent and
 * becomes effective if plugin agents are ever loaded in place. The real fix is
 * to answer ownership from `installed.json` (the authority) instead of the
 * frontmatter cache — tracked as a follow-up.
 */
function isPluginManagedAgent(agent: SubagentDefinition): boolean {
  return isPluginOwnedAgent(agent) || isUnderPluginPackages(agent.filePath);
}

/** Effective roleId for any agent — synthetic for builtins and plugin agents, frontmatter otherwise. */
export function effectiveRoleId(agent: SubagentDefinition): string | undefined {
  if (isBuiltinAgent(agent)) return BUILTIN_ROLE_PREFIX + agent.name;
  if (isPluginManagedAgent(agent)) return PLUGIN_ROLE_PREFIX + agent.name;
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
