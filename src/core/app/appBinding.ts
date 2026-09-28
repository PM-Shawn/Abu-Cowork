import type { AppDefinition, AppMode, AppRunRef, AppScene, ConversationAppBinding, LocalizedText } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { resolveLocalizedText } from '../../../electron/shared/pluginAppSpec.mjs';
import { getLocale } from '@/i18n';

/** `LocalizedText` for the current UI language (zh-CN, then en-US, as fallbacks). */
export function resolveText(text: LocalizedText | undefined): string {
  return resolveLocalizedText(text, getLocale());
}

/** The mode the app home opens on: the remembered one, else `defaultSelected`, else the first. */
export function pickMode(app: AppDefinition, rememberedModeId: string | undefined): AppMode {
  const modes = app.config.home.modes;
  return modes.items.find((mode) => mode.modeId === rememberedModeId)
    ?? modes.items.find((mode) => mode.modeId === modes.defaultSelected)
    ?? modes.items[0];
}

/** Who runs a conversation started from `scene`: the scene's own `run`, else the app's `defaultRun`. */
export function effectiveRun(app: AppDefinition, scene: AppScene | undefined): AppRunRef | undefined {
  return scene?.run ?? app.config.defaultRun;
}

/**
 * The prompt appended for a conversation: app, mode and scene text in that
 * order, blank-line separated, empty pieces dropped.
 */
export function joinPromptAppend(app: AppDefinition, mode: AppMode, scene: AppScene | undefined): string | undefined {
  const parts = [app.config.promptAppend, mode.promptAppend, scene?.promptAppend]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * The record a new conversation carries. Only installed apps bind: the
 * general shell has no plugin behind it and no prompt to append.
 */
export function buildAppBinding(app: AppDefinition, mode: AppMode, scene: AppScene | undefined): ConversationAppBinding | undefined {
  if (app.appId === GENERAL_APP_ID || app.pluginKey === null || app.pluginVersion === null) return undefined;
  return {
    version: 1,
    appId: app.appId,
    pluginKey: app.pluginKey,
    pluginVersion: app.pluginVersion,
    appName: app.name,
    appLogo: app.logo,
    appLogoDark: app.logoDark,
    modeId: mode.modeId,
    sceneId: scene?.id,
    run: effectiveRun(app, scene),
    promptAppend: joinPromptAppend(app, mode, scene),
  };
}

/** The team a `run` points at, as a team-store id; undefined for expert and skill runs. */
export function runTeamId(app: AppDefinition, run: AppRunRef | undefined): string | undefined {
  if (!run || !('team' in run)) return undefined;
  if (run.team.startsWith('builtin-team:')) return run.team;
  return app.pluginKey === null ? undefined : `plugin-team:${app.pluginKey}/${run.team}`;
}

/** The registry name of the expert a `run` points at; undefined for team and skill runs. */
export function runExpertName(run: AppRunRef | undefined): string | undefined {
  if (!run || !('expert' in run)) return undefined;
  return run.expert.startsWith('builtin:') ? run.expert.slice('builtin:'.length) : run.expert;
}
