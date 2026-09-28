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
 * as does the mode picked inside each app. The app lists themselves are
 * rebuilt every launch: the apps the user added from `~/.abu/apps/`
 * (`refreshAddedApps`), the organization's from each sync
 * (`replaceManagedApps`).
 */
export const MAX_RECENT_APPS = 3;

interface AppState {
  /** `GENERAL_APP_ID` when no app is selected. */
  selectedAppId: string;
  /** Most recently entered first, `GENERAL_APP_ID` never listed, at most `MAX_RECENT_APPS`. */
  recentAppIds: string[];
  selectedModeIdByApp: Record<string, string>;
  /** Apps the user added on this computer. Not persisted. */
  addedApps: AppDefinition[];
  /** Apps an organization provides, by the source that registered them. Not persisted. */
  managedApps: Record<string, AppDefinition[]>;
  /**
   * The organization app the user was in when its source went away (the
   * employee went offline). Entered again once the app is back, unless the
   * user picked an app in between. Not persisted.
   */
  suspendedManagedAppId: string | null;
  /** Every app id a list has reported in this session (see `reconcile`). Not persisted. */
  seenAppIds: Record<string, true>;
  /** The `url:` nav item currently shown in the main area. Not persisted. */
  activeAppPage: { appId: string; navItemId: string } | null;
  /** Apps whose "connect your connectors" hint the user dismissed this session. Not persisted. */
  dismissedConnectorHintByApp: Record<string, true>;
  /** The scene whose templates are open on each app's home. Not persisted. */
  expandedSceneIdByApp: Record<string, string | null>;
  /** An app to enter as soon as the next list refresh has it (add-and-enter). Not persisted. */
  pendingEnterAppId: string | null;
  /** Is the app market open? One dialog for the whole shell. Not persisted. */
  appMarketOpen: boolean;
}

interface AppActions {
  /** Throws when `appId` is not an app the switcher lists. */
  enterApp: (appId: string) => void;
  /**
   * Enter `appId` now if it is listed, else on the next list refresh — an add
   * that just finished records the app before the list catches up. A refresh
   * that still does not list it drops the request.
   */
  enterAppWhenAvailable: (appId: string) => void;
  exitApp: () => void;
  selectMode: (appId: string, modeId: string) => void;
  openAppPage: (navItemId: string) => void;
  closeAppPage: () => void;
  dismissConnectorHint: (appId: string) => void;
  setExpandedScene: (appId: string, sceneId: string | null) => void;
  setAddedApps: (apps: AppDefinition[]) => void;
  /** Replace every app `source` provides (an organization sync). */
  replaceManagedApps: (source: string, apps: AppDefinition[]) => void;
  /**
   * Drop every app `source` provides because they are unreachable (offline).
   * The user's place in one of them is remembered and restored once
   * `replaceManagedApps` brings it back.
   */
  clearManagedApps: (source: string) => void;
  /** Open / close 应用市场 — the switcher's 查看更多 and the removed-app notice both land here. */
  setAppMarketOpen: (open: boolean) => void;
}

type AppStore = AppState & AppActions;

type AppLists = Pick<AppState, 'addedApps' | 'managedApps'>;

function managedList(managedApps: AppState['managedApps']): AppDefinition[] {
  return Object.values(managedApps).flat();
}

/** Everything the switcher lists right now, general shell first. */
export function availableApps(state: AppLists, locale: AppLocale = getLocale()): AppDefinition[] {
  return listApps(state.addedApps, managedList(state.managedApps), locale);
}

/** The selected app, or the general shell when the selection no longer exists. */
export function selectedApp(state: AppLists & Pick<AppState, 'selectedAppId'>, locale: AppLocale = getLocale()): AppDefinition {
  const apps = availableApps(state, locale);
  return getApp(apps, state.selectedAppId) ?? apps[0];
}

function landOnHome(): void {
  useChatStore.getState().startNewConversation();
  useSettingsStore.getState().setViewMode('chat');
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => {
      /** Show `appId` (or the general shell) without touching what the user chose to remember. */
      const show = (appId: string) => {
        set((state) => ({
          selectedAppId: appId,
          recentAppIds: appId === GENERAL_APP_ID ? state.recentAppIds : [appId, ...state.recentAppIds.filter((id) => id !== appId)].slice(0, MAX_RECENT_APPS),
          activeAppPage: null,
          // Entering is what the market is for: the dialog closes onto the app.
          appMarketOpen: appId === GENERAL_APP_ID ? state.appMarketOpen : false,
        }));
        landOnHome();
      };

      /**
       * After either list changed: forget recent entries that are gone, enter
       * a pending or suspended app that has arrived, and leave an app that
       * disappeared (removed, disabled by the organization, offline) for the
       * general shell rather than a home nothing can render.
       *
       * "Gone" means listed earlier in this session and not any more. The two
       * lists load at different times — the added apps from disk at launch,
       * the organization's after sign-in — so an app remembered from the last
       * session that no list has reported yet is still on its way, and neither
       * the selection nor the recents forget it.
       */
      const reconcile = (suspendIfGone: boolean) => {
        const ids = new Set(availableApps(get()).map((app) => app.appId));
        const { pendingEnterAppId, suspendedManagedAppId, selectedAppId, seenAppIds } = get();
        const gone = (id: string) => seenAppIds[id] === true && !ids.has(id);
        set((state) => ({
          recentAppIds: state.recentAppIds.filter((id) => !gone(id)),
          pendingEnterAppId: null,
          seenAppIds: { ...state.seenAppIds, ...Object.fromEntries([...ids].map((id) => [id, true as const])) },
        }));
        if (pendingEnterAppId && ids.has(pendingEnterAppId)) {
          set({ suspendedManagedAppId: null });
          show(pendingEnterAppId);
          return;
        }
        if (selectedAppId !== GENERAL_APP_ID && gone(selectedAppId)) {
          set({ suspendedManagedAppId: suspendIfGone ? selectedAppId : null });
          show(GENERAL_APP_ID);
          return;
        }
        if (suspendedManagedAppId && selectedAppId === GENERAL_APP_ID && ids.has(suspendedManagedAppId)) {
          set({ suspendedManagedAppId: null });
          show(suspendedManagedAppId);
        }
      };

      return {
        selectedAppId: GENERAL_APP_ID,
        recentAppIds: [],
        selectedModeIdByApp: {},
        addedApps: [],
        managedApps: {},
        suspendedManagedAppId: null,
        seenAppIds: {},
        activeAppPage: null,
        dismissedConnectorHintByApp: {},
        expandedSceneIdByApp: {},
        pendingEnterAppId: null,
        appMarketOpen: false,

        setAppMarketOpen: (open) => set({ appMarketOpen: open }),

        enterAppWhenAvailable: (appId) => {
          if (getApp(availableApps(get()), appId)) { get().enterApp(appId); return; }
          set({ pendingEnterAppId: appId });
        },

        enterApp: (appId) => {
          if (appId === GENERAL_APP_ID) { get().exitApp(); return; }
          if (!getApp(availableApps(get()), appId)) throw new Error(`app "${appId}" is not available`);
          // The user chose where to be; an organization app waiting for the
          // connection to come back no longer decides that.
          set({ suspendedManagedAppId: null });
          show(appId);
        },

        exitApp: () => {
          set({ suspendedManagedAppId: null });
          show(GENERAL_APP_ID);
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

        setAddedApps: (apps) => {
          set({ addedApps: apps });
          reconcile(false);
        },

        replaceManagedApps: (source, apps) => {
          set((state) => ({ managedApps: { ...state.managedApps, [source]: apps } }));
          reconcile(false);
        },

        clearManagedApps: (source) => {
          set((state) => {
            const managedApps = { ...state.managedApps };
            delete managedApps[source];
            return { managedApps };
          });
          reconcile(true);
        },
      };
    },
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
  const addedApps = useAppStore((s) => s.addedApps);
  const managedApps = useAppStore((s) => s.managedApps);
  const selectedAppId = useAppStore((s) => s.selectedAppId);
  const { locale } = useI18n();
  return useMemo(() => selectedApp({ addedApps, managedApps, selectedAppId }, locale), [addedApps, managedApps, selectedAppId, locale]);
}

/** Every app the switcher lists, general shell first. */
export function useAvailableApps(): AppDefinition[] {
  const addedApps = useAppStore((s) => s.addedApps);
  const managedApps = useAppStore((s) => s.managedApps);
  const { locale } = useI18n();
  return useMemo(() => availableApps({ addedApps, managedApps }, locale), [addedApps, managedApps, locale]);
}
