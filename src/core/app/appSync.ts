import { homeDir } from '@tauri-apps/api/path';
import { useAppStore } from '@/stores/appStore';
import { loadAddedApps, removeAddedApp } from './appRecords';
import { destroyAppPages, setManagedAppPages } from './appPageBridge';
import { hasElectronCommandHost } from '@/utils/electronHost';

let generation = 0;

/**
 * Reload `appStore.addedApps` from `~/.abu/apps/`. Called at launch and after
 * every add, update and removal. Loads are ordered by generation so a slower
 * earlier read cannot overwrite a later one. An app that left the list has no
 * page to show any more: its native views and its page login state go too.
 */
export async function refreshAddedApps(): Promise<void> {
  const current = ++generation;
  const apps = await loadAddedApps(await homeDir());
  if (current !== generation) return;
  const before = useAppStore.getState().addedApps;
  useAppStore.getState().setAddedApps(apps);
  if (!hasElectronCommandHost()) return;
  const remaining = new Set(apps.map((app) => app.appId));
  for (const app of before) {
    if (!remaining.has(app.appId)) await destroyAppPages(app.appId, true);
  }
}

/** Remove an added app (the switcher's 「移除」): only the app; plugins, experts, teams and skills stay. */
export async function removeApp(appId: string): Promise<void> {
  await removeAddedApp(await homeDir(), appId);
  await refreshAddedApps();
}

/**
 * Organization apps have no files on this computer, so the page host is told
 * their page configuration each time a sync replaces them; it keeps checking
 * origins itself and closes pages of apps that left.
 */
function syncManagedAppPages(): () => void {
  return useAppStore.subscribe((state, previous) => {
    if (state.managedApps === previous.managedApps || !hasElectronCommandHost()) return;
    const apps = Object.values(state.managedApps).flat().map((app) => ({ appId: app.appId, nav: app.config.nav, allowedOrigins: app.config.allowedOrigins }));
    void setManagedAppPages(apps);
  });
}

/** Load the added apps once at launch and keep the page host in step with organization apps. */
export function initAddedAppsSync(): void {
  syncManagedAppPages();
  void refreshAddedApps();
}
