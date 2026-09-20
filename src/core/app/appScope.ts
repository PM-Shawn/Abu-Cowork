import type { AppDefinition, AppRunRef } from '@/types/app';
import type { SubagentMetadata } from '@/types';
import { PLUGIN_TEAM_ID_PREFIX } from '@/core/team/pluginTeams';
import { runExpertName, runTeamId } from './appBinding';

/**
 * What the 「专家」 page shows under 「本应用」 (product spec §5.5): the experts
 * and teams the app's plugin ships, plus the built-in ones its scenes hand
 * work to.
 */
function runs(app: AppDefinition): AppRunRef[] {
  const scenes = app.config.home.modes.items.flatMap((mode) => mode.scenes);
  return [app.config.defaultRun, ...scenes.map((scene) => scene.run)].filter((run): run is AppRunRef => run !== undefined);
}

export function appTeamIds(app: AppDefinition): Set<string> {
  return new Set(runs(app).map((run) => runTeamId(app, run)).filter((id): id is string => id !== undefined));
}

/** Is `teamId` the app's own (plugin) team, or a built-in team one of its scenes uses? */
export function teamBelongsToApp(app: AppDefinition, teamId: string): boolean {
  if (app.pluginKey !== null && teamId.startsWith(`${PLUGIN_TEAM_ID_PREFIX}${app.pluginKey}/`)) return true;
  return appTeamIds(app).has(teamId);
}

/** Is this expert the app plugin's own, or a built-in expert one of its scenes uses? */
export function agentBelongsToApp(app: AppDefinition, agent: Pick<SubagentMetadata, 'name' | 'source'>): boolean {
  if (app.pluginKey !== null && agent.source?.kind === 'plugin' && agent.source.plugin === app.pluginKey) return true;
  return runs(app).some((run) => runExpertName(run) === agent.name);
}
