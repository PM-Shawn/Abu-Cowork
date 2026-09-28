import type { AppDefinition, AppLocale, AppRunRef } from '@/types/app';
import { getLocale } from '@/i18n';
import type { SkillMetadata, SubagentDefinition, SubagentMetadata } from '@/types';
import type { Team, TeamStore } from '@/stores/teamStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import type { PluginActivations } from '@/core/plugin/activationPolicy';
import { useTeamStore } from '@/stores/teamStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { agentRegistry } from '@/core/agent/registry';
import { isBuiltinAgent } from '@/core/team/roleIdentity';
import { isPluginOwnedAgent } from '@/utils/agentSource';
import { pluginTeamId } from '@/core/team/pluginTeams';
import { appRuns, splitRunTarget, type RunTargetKind } from '../../../electron/shared/appSpec.mjs';

/**
 * Whether an app's references name something that exists on this computer
 * right now (docs/app-spec.md). The app file only says what it wants; this
 * answers against the live catalog, so it is asked again whenever it matters —
 * when the app is added, and each time a scene is started — and a plugin
 * uninstalled or an expert deleted since then is noticed.
 */

/** A plugin as far as references care: which one, whether it runs, what it brought. */
export interface CatalogPlugin {
  key: string;
  name: string;
  marketplace: string;
  enabled: boolean;
  contributed: { skills: string[]; agents: string[]; teams: string[]; mcpServers: string[] };
}

export interface RefCatalog {
  plugins: CatalogPlugin[];
  /** Every team the store holds (built-in, plugin, the user's) plus active organization teams. */
  teams: Team[];
  /** A runnable expert by name (ready and allowed). */
  getAgent: (name: string) => SubagentDefinition | undefined;
  /** An organization expert by role id, ready or not. */
  findManagedAgent: (roleId: string) => SubagentDefinition | undefined;
  /** Names of the skills Abu can load. */
  skillNames: ReadonlySet<string>;
}

/** What the catalog is built from: the plugin records, the teams, and the discovered experts and skills. */
export interface RefCatalogInput {
  installed: InstalledPlugin[];
  activations: PluginActivations;
  teams: Team[];
  managedTeamSources: TeamStore['managedTeamSources'];
  agents: SubagentMetadata[];
  skills: SkillMetadata[];
}

/**
 * A catalog over the given store values. Components pass the values they
 * subscribe to, so the catalog is rebuilt exactly when one of them changes;
 * experts are then read from the registry, limited to the discovered ones.
 */
export function refCatalogFrom(input: RefCatalogInput): RefCatalog {
  const managed = Object.values(input.managedTeamSources).filter((source) => source.isActive()).flatMap((source) => source.teams);
  const agentNames = new Set(input.agents.map((agent) => agent.name));
  return {
    plugins: input.installed.map((plugin) => ({
      key: plugin.key,
      name: plugin.name,
      marketplace: plugin.marketplace,
      enabled: input.activations[plugin.key]?.enabled === true && input.activations[plugin.key]?.conflicted !== true,
      contributed: plugin.contributed,
    })),
    teams: [...input.teams, ...managed.filter((team) => !input.teams.some((item) => item.id === team.id))],
    getAgent: (name) => (agentNames.has(name) ? agentRegistry.getAgent(name) : undefined),
    findManagedAgent: (roleId) => agentRegistry.findManagedAgent(roleId),
    skillNames: new Set(input.skills.map((skill) => skill.name)),
  };
}

/** The catalog as it stands in the running app. */
export function liveRefCatalog(): RefCatalog {
  const { installed, activationByKey } = usePluginStore.getState();
  const { teams, managedTeamSources } = useTeamStore.getState();
  const { agents, skills } = useDiscoveryStore.getState();
  return refCatalogFrom({ installed, activations: activationByKey, teams, managedTeamSources, agents, skills });
}

/** What one reference resolves to. */
export type ResolvedTarget =
  | { status: 'ok'; kind: 'team'; team: Team }
  | { status: 'ok'; kind: 'expert'; agent: SubagentDefinition }
  | { status: 'ok'; kind: 'skill'; name: string }
  /** The plugin it comes from is not installed, or its installed version does not bring it. */
  | { status: 'needs-plugin'; plugin: string; reason: 'missing' | 'outdated' }
  /** An organization expert (or a team member) whose organization skills or connectors are not set up yet. */
  | { status: 'needs-preparation'; roleIds: string[]; label: string }
  /** Gone and not coming back by installing anything: deleted, or its plugin switched off. */
  | { status: 'unavailable'; label: string };

export interface ResolvedRun {
  owner?: ResolvedTarget;
  skill?: ResolvedTarget;
}

/**
 * The installed plugin a `plugin:<name>/…` reference means: the one from the
 * app's own market when there is one, else any installed plugin of that name.
 */
function findPlugin(catalog: RefCatalog, app: AppDefinition, name: string): CatalogPlugin | undefined {
  const matches = catalog.plugins.filter((plugin) => plugin.name === name);
  const market = app.origin?.kind === 'market' ? app.origin.market : undefined;
  return matches.find((plugin) => plugin.marketplace === market) ?? matches[0];
}

/** An expert the user made (what a `mine:` expert reference may name). */
export function isUsersOwnAgent(agent: SubagentDefinition): boolean {
  return !agent.managed && !isBuiltinAgent(agent) && !isPluginOwnedAgent(agent);
}

/** A team the user made (what a `mine:` team reference may name). */
export function isUsersOwnTeam(team: Team): boolean {
  return !team.managed && !team.id.startsWith('builtin-team:') && !team.id.startsWith('plugin-team:');
}

function unreadyMembers(team: Team, catalog: RefCatalog): string[] {
  return team.memberRoleIds.filter((roleId) => {
    const agent = catalog.findManagedAgent(roleId);
    return agent !== undefined && agent.managed?.ready !== true;
  });
}

export function resolveTarget(app: AppDefinition, kind: RunTargetKind, value: string, catalog: RefCatalog): ResolvedTarget {
  const target = splitRunTarget(kind, value);
  if (!target) return { status: 'unavailable', label: value };
  if (target.origin === 'plugin') {
    const plugin = findPlugin(catalog, app, target.plugin);
    if (!plugin) return { status: 'needs-plugin', plugin: target.plugin, reason: 'missing' };
    const brought = kind === 'team' ? plugin.contributed.teams : kind === 'expert' ? plugin.contributed.agents : plugin.contributed.skills;
    if (!brought.includes(target.id)) return { status: 'needs-plugin', plugin: target.plugin, reason: 'outdated' };
    if (!plugin.enabled) return { status: 'unavailable', label: target.id };
    if (kind === 'team') {
      const team = catalog.teams.find((item) => item.id === pluginTeamId(plugin.key, target.id));
      return team ? { status: 'ok', kind, team } : { status: 'unavailable', label: target.id };
    }
    if (kind === 'expert') {
      const agent = catalog.getAgent(target.id);
      return agent && isPluginOwnedAgent(agent) ? { status: 'ok', kind, agent } : { status: 'unavailable', label: target.id };
    }
    return { status: 'ok', kind, name: target.id };
  }
  if (kind === 'team') {
    const team = catalog.teams.find((item) => item.id === target.id);
    if (!team) return { status: 'unavailable', label: target.id };
    if (target.origin === 'mine' && !isUsersOwnTeam(team)) return { status: 'unavailable', label: target.id };
    if (target.origin === 'enterprise') {
      if (!team.managed) return { status: 'unavailable', label: target.id };
      const unready = unreadyMembers(team, catalog);
      if (unready.length > 0) return { status: 'needs-preparation', roleIds: unready, label: team.name };
    }
    return { status: 'ok', kind, team };
  }
  if (kind === 'expert') {
    if (target.origin === 'enterprise') {
      const agent = catalog.findManagedAgent(value);
      if (!agent) return { status: 'unavailable', label: target.id };
      if (agent.managed?.ready !== true) return { status: 'needs-preparation', roleIds: [value], label: agent.name };
      return { status: 'ok', kind, agent };
    }
    const agent = catalog.getAgent(target.id);
    if (!agent) return { status: 'unavailable', label: target.id };
    if (target.origin === 'builtin' && !isBuiltinAgent(agent)) return { status: 'unavailable', label: target.id };
    if (target.origin === 'mine' && !isUsersOwnAgent(agent)) return { status: 'unavailable', label: target.id };
    return { status: 'ok', kind, agent };
  }
  return catalog.skillNames.has(target.id) ? { status: 'ok', kind, name: target.id } : { status: 'unavailable', label: target.id };
}

/** The name a user knows a target by: a team's or an expert's display name, never an id. */
export function targetDisplayName(target: ResolvedTarget, locale: AppLocale = getLocale()): string {
  if (target.status === 'ok') {
    if (target.kind === 'team') return target.team.name;
    if (target.kind === 'expert') return target.agent.displayNames?.[locale] ?? target.agent.name;
    return target.name;
  }
  if (target.status === 'needs-plugin') return target.plugin;
  return target.label;
}

export function resolveRun(app: AppDefinition, run: AppRunRef, catalog: RefCatalog): ResolvedRun {
  const resolved: ResolvedRun = {};
  if ('team' in run) resolved.owner = resolveTarget(app, 'team', run.team, catalog);
  if ('expert' in run) resolved.owner = resolveTarget(app, 'expert', run.expert, catalog);
  if (run.skill !== undefined) resolved.skill = resolveTarget(app, 'skill', run.skill, catalog);
  return resolved;
}

/** The targets of a resolved run, owner first. */
export function runTargets(resolved: ResolvedRun): ResolvedTarget[] {
  return [resolved.owner, resolved.skill].filter((target): target is ResolvedTarget => target !== undefined);
}

export interface AppRefsReport {
  runs: Array<{ field: string; modeId?: string; sceneId?: string; run: AppRunRef; resolved: ResolvedRun }>;
  /** Plugins to install for the app's references to resolve, by name. */
  missingPlugins: string[];
  /** Installed plugins whose version does not bring what the app references, by name. */
  outdatedPlugins: string[];
}

/** Every run of the app, resolved, plus the plugins that would have to be installed or updated. */
export function resolveAppRefs(app: AppDefinition, catalog: RefCatalog): AppRefsReport {
  const runs = appRuns(app.config).map((entry) => ({ ...entry, resolved: resolveRun(app, entry.run, catalog) }));
  const missing = new Set<string>();
  const outdated = new Set<string>();
  for (const entry of runs) {
    for (const target of runTargets(entry.resolved)) {
      if (target.status !== 'needs-plugin') continue;
      (target.reason === 'missing' ? missing : outdated).add(target.plugin);
    }
  }
  return { runs, missingPlugins: [...missing], outdatedPlugins: [...outdated] };
}
