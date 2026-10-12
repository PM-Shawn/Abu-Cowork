import type { ConversationAppBinding } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { selectedApp, useAppStore } from '@/stores/appStore';
import { buildAppBinding, effectiveRun, pickMode } from './appBinding';
import { liveRefCatalog, resolveRun, type ResolvedRun } from './appRefs';

/** The team a run resolves to, for pinning a conversation to it. */
export function resolvedTeamId(resolved: ResolvedRun | undefined): string | undefined {
  const owner = resolved?.owner;
  return owner?.status === 'ok' && owner.kind === 'team' ? owner.team.id : undefined;
}

/** What a conversation started inside an app carries. */
export interface AppHomePicks {
  binding: ConversationAppBinding | undefined;
  /** The team the app's default run names, when it resolves to one. */
  teamId: string | undefined;
}

/**
 * The picks of the app the shell is in, read from the stores as they stand:
 * the binding for the mode and the scene open on its home, and its default
 * team. `undefined` in the general shell. For a conversation that starts while
 * the app home is not in view; the home keeps its own picks in
 * `chatStore.pendingAppBinding` / `pendingTeamId` while it is.
 */
export function appHomePicks(): AppHomePicks | undefined {
  const apps = useAppStore.getState();
  const app = selectedApp(apps);
  if (app.appId === GENERAL_APP_ID) return undefined;
  const mode = pickMode(app, apps.selectedModeIdByApp[app.appId]);
  const scene = mode.scenes.find((item) => item.id === apps.expandedSceneIdByApp[app.appId]);
  const run = effectiveRun(app, undefined);
  return {
    binding: buildAppBinding(app, mode, scene),
    teamId: resolvedTeamId(run ? resolveRun(app, run, liveRefCatalog()) : undefined),
  };
}
