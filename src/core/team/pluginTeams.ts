import { readTextFile } from '@tauri-apps/plugin-fs';
import type { Team } from '@/stores/teamStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import type { PluginActivations } from '@/core/plugin/activationPolicy';
import { parseTeamFile, resolveLocalizedText } from '../../../electron/shared/pluginAppSpec.mjs';
import type { AppLocale, ParsedPluginTeam } from '@/types/app';
import { joinPath } from '@/utils/pathUtils';

/**
 * Teams a plugin ships (`teams/<id>.json`, developer spec §6) — the third
 * team family next to the user's own and the built-ins. They live in the
 * installed package and are never persisted by the team store: the store
 * re-reads them whenever the plugin records or their activation change, so a
 * disabled or uninstalled plugin's teams disappear with it.
 *
 * Ids are `plugin-team:<pluginKey>/<teamId>`; member role ids come out of the
 * same validator the installer ran (`plugin:<name>` for the package's own
 * experts, `builtin:<name>` for Abu's).
 */
export const PLUGIN_TEAM_ID_PREFIX = 'plugin-team:';

export function isPluginTeam(team: Pick<Team, 'id'>): boolean {
  return team.id.startsWith(PLUGIN_TEAM_ID_PREFIX);
}

export function pluginTeamId(pluginKey: string, teamId: string): string {
  return `${PLUGIN_TEAM_ID_PREFIX}${pluginKey}/${teamId}`;
}

/** The plugin key and team id behind a `plugin-team:` id; null for any other id. */
export function parsePluginTeamId(id: string): { pluginKey: string; teamId: string } | null {
  if (!isPluginTeam({ id })) return null;
  const rest = id.slice(PLUGIN_TEAM_ID_PREFIX.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { pluginKey: rest.slice(0, slash), teamId: rest.slice(slash + 1) };
}

/** `plugin:<name>` → `<name>` for display; other ids unchanged. */
export function pluginTeamOwner(team: Pick<Team, 'id'>): string | null {
  return parsePluginTeamId(team.id)?.pluginKey ?? null;
}

/** A validated team file as the team store carries it, text resolved for `locale`. */
export function toTeam(parsed: ParsedPluginTeam, pluginKey: string, locale: AppLocale): Team {
  const text = (value: Parameters<typeof resolveLocalizedText>[0]) => resolveLocalizedText(value, locale);
  return {
    id: pluginTeamId(pluginKey, parsed.id),
    name: text(parsed.name),
    leaderRoleId: parsed.leaderRoleId,
    memberRoleIds: parsed.memberRoleIds,
    leaderNote: parsed.leaderNote,
    requirePlanApproval: parsed.requirePlanApproval || undefined,
    avatar: parsed.avatar,
    description: text(parsed.description),
    intro: parsed.intro === undefined ? undefined : text(parsed.intro),
    expertise: parsed.expertise.length ? parsed.expertise.map(text) : undefined,
    samplePrompts: parsed.samplePrompts.length ? parsed.samplePrompts.map(text) : undefined,
    createdAt: 0,
  };
}

/**
 * Read every team of every enabled plugin. The list of team ids and the
 * package root come from the install record and its activation — the same
 * ownership the skill loader and the agent gate consult — never from a
 * directory scan, so a package cannot gain a team after the user approved it.
 *
 * One unreadable file decides one team. A package directory a user deleted by
 * hand is a state the uninstaller already treats as normal (`tolerateMissingDir`),
 * and letting it reject the whole read would freeze the team list on whatever
 * it held: every other plugin's teams would then survive their own plugin's
 * removal until the next restart. The failure is reported rather than hidden.
 */
export async function loadPluginTeams(
  installed: InstalledPlugin[],
  activations: PluginActivations,
  locale: AppLocale,
  readText: (path: string) => Promise<string> = readTextFile,
): Promise<Team[]> {
  const teams: Team[] = [];
  for (const plugin of installed) {
    const activation = activations[plugin.key];
    if (!activation || !activation.enabled || activation.conflicted || plugin.contributed.teams.length === 0) continue;
    for (const teamId of plugin.contributed.teams) {
      try {
        const raw: unknown = JSON.parse(await readText(joinPath(activation.root, 'teams', `${teamId}.json`)));
        const parsed = parseTeamFile(raw, teamId, { agentNames: plugin.contributed.agents });
        teams.push(toTeam(parsed, plugin.key, locale));
      } catch (error) {
        console.error(`[plugin-team] ${plugin.key} lists the team "${teamId}", which could not be read; it stays out of the team list.`, error);
      }
    }
  }
  return teams;
}
