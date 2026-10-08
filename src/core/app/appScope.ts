import type { AppDefinition } from '@/types/app';
import { liveRefCatalog, resolveAppRefs, runTargets, type RefCatalog } from './appRefs';
import { appRuns, splitRunTarget } from '../../../electron/shared/appSpec.mjs';

/**
 * What the 「专家」 page shows under 「本应用」 (product spec §5.5): the experts
 * and teams the app's scenes and its default run name — whoever they come
 * from, and nothing the app does not name.
 */
export interface AppMembers {
  teamIds: ReadonlySet<string>;
  agentNames: ReadonlySet<string>;
}

export function appMembers(app: AppDefinition, catalog: RefCatalog = liveRefCatalog()): AppMembers {
  const teamIds = new Set<string>();
  const agentNames = new Set<string>();
  for (const entry of resolveAppRefs(app, catalog).runs) {
    for (const target of runTargets(entry.resolved)) {
      if (target.status !== 'ok') continue;
      if (target.kind === 'team') teamIds.add(target.team.id);
      if (target.kind === 'expert') agentNames.add(target.agent.name);
    }
  }
  return { teamIds, agentNames };
}

/**
 * What an added app would lose, for the confirmations that remove something
 * an app names: a plugin (by name), or the user's own expert (by name) or team
 * (by id).
 */
export type AppDependency =
  | { kind: 'plugin'; name: string }
  | { kind: 'expert'; name: string }
  | { kind: 'team'; id: string };

function names(app: AppDefinition, dependency: AppDependency): boolean {
  if (dependency.kind === 'plugin') return app.plugins.includes(dependency.name);
  return appRuns(app.config).some(({ run }) => {
    if (dependency.kind === 'expert' && 'expert' in run) {
      const target = splitRunTarget('expert', run.expert);
      return target?.origin === 'mine' && target.id === dependency.name;
    }
    if (dependency.kind === 'team' && 'team' in run) {
      const target = splitRunTarget('team', run.team);
      return target?.origin === 'mine' && target.id === dependency.id;
    }
    return false;
  });
}

/** The apps among `apps` that name `dependency`. */
export function appsUsing(apps: readonly AppDefinition[], dependency: AppDependency): AppDefinition[] {
  return apps.filter((app) => names(app, dependency));
}
