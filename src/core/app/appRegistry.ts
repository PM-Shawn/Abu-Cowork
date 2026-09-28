import type { AppDefinition, AppLocale } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { resolveLocalizedText } from '../../../electron/shared/specFields.mjs';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';

/**
 * Where the switcher's apps come from: the general shell, the apps the user
 * added on this computer (`appRecords.ts`), and the apps an organization
 * provides (`useAppStore.replaceManagedApps`).
 */
const dictionaries = { 'zh-CN': zhCN, 'en-US': enUS } as const;

/** The general shell as an app: first in every list, never persisted, nothing behind it. */
export function generalApp(locale: AppLocale): AppDefinition {
  return {
    appId: GENERAL_APP_ID,
    name: dictionaries[locale].appSwitcher.general,
    description: dictionaries[locale].appSwitcher.generalDescription,
    config: DEFAULT_APP_CONFIG,
    version: null,
    origin: null,
    plugins: [],
  };
}

/** The general shell, then organization apps, then the apps the user added. */
export function listApps(addedApps: AppDefinition[], managedApps: AppDefinition[], locale: AppLocale): AppDefinition[] {
  return [generalApp(locale), ...managedApps, ...addedApps];
}

export function getApp(apps: AppDefinition[], appId: string): AppDefinition | undefined {
  return apps.find((app) => app.appId === appId);
}

/** The app's display title for the home header: `home.header.title`, else its name. */
export function appHomeTitle(app: AppDefinition, locale: AppLocale): string {
  const title = app.config.home.header?.title;
  return title === undefined ? app.name : resolveLocalizedText(title, locale);
}
