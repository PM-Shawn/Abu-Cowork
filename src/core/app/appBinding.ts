import type { AppDefinition, AppMode, AppRunRef, AppScene, ConversationAppBinding, LocalizedText } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { resolveLocalizedText } from '../../../electron/shared/specFields.mjs';
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
 * The record a new conversation carries. Only real apps bind: the general
 * shell has no app behind it and no prompt to append.
 */
export function buildAppBinding(app: AppDefinition, mode: AppMode, scene: AppScene | undefined): ConversationAppBinding | undefined {
  if (app.appId === GENERAL_APP_ID || app.origin === null || app.version === null) return undefined;
  return {
    version: 2,
    appId: app.appId,
    appVersion: app.version,
    origin: app.origin.kind,
    appName: app.name,
    appLogo: app.logo,
    appLogoDark: app.logoDark,
    appIcon: app.icon,
    modeId: mode.modeId,
    sceneId: scene?.id,
    run: effectiveRun(app, scene),
    promptAppend: joinPromptAppend(app, mode, scene),
  };
}
