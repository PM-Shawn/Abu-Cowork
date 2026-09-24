import { usePluginStore } from '@/stores/pluginStore';
import { useAppStore } from '@/stores/appStore';
import { loadInstalledApps } from './appRegistry';
import { destroyAppPagesForPlugin } from './appPageBridge';
import { hasElectronCommandHost } from '@/utils/electronHost';

/**
 * Keep `appStore.installedApps` in step with the plugin records: reload
 * whenever the install records or their activation change, only once the
 * records reflect a successful read of `installed.json` (while a refresh is
 * in flight the previous list stays, so the switcher never blinks empty).
 * Loads are ordered by generation so a slower earlier read cannot overwrite
 * a later one — the same shape as `initPluginTeamsSync`.
 */
export function initInstalledAppsSync(): () => void {
  let generation = 0;
  const refresh = () => {
    const { installed, activationByKey, activationReady } = usePluginStore.getState();
    if (!activationReady) return;
    const current = ++generation;
    void loadInstalledApps(installed, activationByKey).then((apps) => {
      if (current !== generation) return;
      const before = useAppStore.getState().installedApps;
      useAppStore.getState().setInstalledApps(apps);
      // An app that left the list has no page to show any more: its native
      // views go; its login state goes too when the plugin itself is gone
      // (uninstalled), and stays for one that is merely disabled.
      if (!hasElectronCommandHost()) return;
      const remaining = new Set(apps.map((app) => app.appId));
      const stillInstalled = new Set(installed.map((plugin) => plugin.key));
      for (const app of before) {
        if (remaining.has(app.appId) || app.pluginKey === null) continue;
        void destroyAppPagesForPlugin(app.pluginKey, !stillInstalled.has(app.pluginKey));
      }
    });
  };
  const unsubscribe = usePluginStore.subscribe((state, previous) => {
    if (state.installed !== previous.installed || state.activationByKey !== previous.activationByKey || state.activationReady !== previous.activationReady) refresh();
  });
  refresh();
  return unsubscribe;
}
