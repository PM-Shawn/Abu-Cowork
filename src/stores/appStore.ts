import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppDefinition, AppLocale } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { getApp, listApps } from '@/core/app/appRegistry';
import { getLocale, useI18n } from '@/i18n';
import { useSettingsStore } from './settingsStore';
import { useChatStore } from './chatStore';

/**
 * Which app the shell is showing (product spec §5.1). Entering an app swaps
 * the sidebar navigation and the welcome page for that app's; the
 * conversation list, projects and account stay. The choice survives a restart,
 * as does the mode picked inside each app; the installed-app list itself is
 * rebuilt from the plugin records on every launch (`initInstalledAppsSync`).
 */
export const MAX_RECENT_APPS = 3;

interface AppState {
  /** `GENERAL_APP_ID` when no app is selected. */
  selectedAppId: string;
  /** Most recently entered first, `GENERAL_APP_ID` never listed, at most `MAX_RECENT_APPS`. */
  recentAppIds: string[];
  selectedModeIdByApp: Record<string, string>;
  /** Apps read from the enabled installed plugins. Not persisted. */
  installedApps: AppDefinition[];
  /** The `url:` nav item currently shown in the main area. Not persisted. */
  activeAppPage: { appId: string; navItemId: string } | null;
  /** Apps whose "connect your connectors" hint the user dismissed this session. Not persisted. */
  dismissedConnectorHintByApp: Record<string, true>;
  /** The scene whose templates are open on each app's home. Not persisted. */
  expandedSceneIdByApp: Record<string, string | null>;
  /** An app to enter as soon as the next record refresh lists it (install-and-enter). Not persisted. */
  pendingEnterAppId: string | null;
}

interface AppActions {
  /** Throws when `appId` is not an app the switcher lists. */
  enterApp: (appId: string) => void;
  /**
   * Enter `appId` now if it is listed, else on the next installed-app refresh
   * — the install that just finished publishes its record before the app list
   * catches up. A refresh that still does not list it drops the request.
   */
  enterAppWhenAvailable: (appId: string) => void;
  exitApp: () => void;
  selectMode: (appId: string, modeId: string) => void;
  openAppPage: (navItemId: string) => void;
  closeAppPage: () => void;
  dismissConnectorHint: (appId: string) => void;
  setExpandedScene: (appId: string, sceneId: string | null) => void;
  setInstalledApps: (apps: AppDefinition[]) => void;
}

type AppStore = AppState & AppActions;

/** Everything the switcher lists right now, general shell first. */
export function availableApps(state: Pick<AppState, 'installedApps'>, locale: AppLocale = getLocale()): AppDefinition[] {
  return listApps(state.installedApps, locale);
}

/** The selected app, or the general shell when the selection no longer exists. */
export function selectedApp(state: Pick<AppState, 'installedApps' | 'selectedAppId'>, locale: AppLocale = getLocale()): AppDefinition {
  const apps = availableApps(state, locale);
  return getApp(apps, state.selectedAppId) ?? apps[0];
}

function landOnHome(): void {
  useChatStore.getState().startNewConversation();
  useSettingsStore.getState().setViewMode('chat');
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      selectedAppId: GENERAL_APP_ID,
      recentAppIds: [],
      selectedModeIdByApp: {},
      installedApps: [],
      activeAppPage: null,
      dismissedConnectorHintByApp: {},
      expandedSceneIdByApp: {},
      pendingEnterAppId: null,

      enterAppWhenAvailable: (appId) => {
        if (getApp(availableApps(get()), appId)) { get().enterApp(appId); return; }
        set({ pendingEnterAppId: appId });
      },

      enterApp: (appId) => {
        if (appId === GENERAL_APP_ID) { get().exitApp(); return; }
        if (!getApp(availableApps(get()), appId)) throw new Error(`app "${appId}" is not installed`);
        set((state) => ({
          selectedAppId: appId,
          recentAppIds: [appId, ...state.recentAppIds.filter((id) => id !== appId)].slice(0, MAX_RECENT_APPS),
          activeAppPage: null,
        }));
        landOnHome();
      },

      exitApp: () => {
        set({ selectedAppId: GENERAL_APP_ID, activeAppPage: null });
        landOnHome();
      },

      selectMode: (appId, modeId) => set((state) => ({ selectedModeIdByApp: { ...state.selectedModeIdByApp, [appId]: modeId } })),

      openAppPage: (navItemId) => {
        const app = selectedApp(get());
        if (app.appId === GENERAL_APP_ID) throw new Error('the general shell has no app pages');
        if (!app.config.nav?.items.some((item) => item.id === navItemId && item.target.startsWith('url:'))) {
          throw new Error(`nav item "${navItemId}" is not a page of app "${app.appId}"`);
        }
        set({ activeAppPage: { appId: app.appId, navItemId } });
        useSettingsStore.getState().setViewMode('app-page');
      },

      closeAppPage: () => set({ activeAppPage: null }),

      dismissConnectorHint: (appId) => set((state) => ({ dismissedConnectorHintByApp: { ...state.dismissedConnectorHintByApp, [appId]: true } })),

      setExpandedScene: (appId, sceneId) => set((state) => ({ expandedSceneIdByApp: { ...state.expandedSceneIdByApp, [appId]: sceneId } })),

      setInstalledApps: (apps) => {
        const ids = new Set(apps.map((app) => app.appId));
        const pendingEnter = get().pendingEnterAppId;
        set((state) => ({
          installedApps: apps,
          recentAppIds: state.recentAppIds.filter((id) => ids.has(id)),
          pendingEnterAppId: null,
        }));
        if (pendingEnter && ids.has(pendingEnter)) { get().enterApp(pendingEnter); return; }
        // The app the user was in is gone (uninstalled or disabled): back to
        // the general shell rather than a home nothing can render.
        const { selectedAppId } = get();
        if (selectedAppId !== GENERAL_APP_ID && !ids.has(selectedAppId)) get().exitApp();
      },
    }),
    {
      name: 'abu-app',
      version: 1,
      partialize: (state) => ({
        selectedAppId: state.selectedAppId,
        recentAppIds: state.recentAppIds,
        selectedModeIdByApp: state.selectedModeIdByApp,
      }),
    },
  ),
);

/** The app the shell is currently showing (general shell when none). */
export function useSelectedApp(): AppDefinition {
  const installedApps = useAppStore((s) => s.installedApps);
  const selectedAppId = useAppStore((s) => s.selectedAppId);
  const { locale } = useI18n();
  return useMemo(() => selectedApp({ installedApps, selectedAppId }, locale), [installedApps, selectedAppId, locale]);
}

/** Every app the switcher lists, general shell first. */
export function useAvailableApps(): AppDefinition[] {
  const installedApps = useAppStore((s) => s.installedApps);
  const { locale } = useI18n();
  return useMemo(() => availableApps({ installedApps }, locale), [installedApps, locale]);
}
