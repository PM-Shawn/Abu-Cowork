import { usePluginStore } from '@/stores/pluginStore';
import { useTeamStore } from '@/stores/teamStore';
import { getLocale, subscribeLanguage } from '@/i18n';
import { loadPluginTeams } from './pluginTeams';

/**
 * Keep the team store's plugin teams in step with the plugin records: a
 * (re)load runs whenever the install records, their activation or the UI
 * language change, and only once the records reflect a successful read of
 * `installed.json` — while a refresh is in flight the previously loaded teams
 * stay, so a conversation pinned to one never sees it flicker away.
 *
 * Loads are ordered by generation: a slower earlier read cannot overwrite a
 * later one.
 */
export function initPluginTeamsSync(): () => void {
  let generation = 0;
  const refresh = () => {
    const { installed, activationByKey, activationReady } = usePluginStore.getState();
    if (!activationReady) return;
    const current = ++generation;
    void loadPluginTeams(installed, activationByKey, getLocale()).then((teams) => {
      if (current === generation) useTeamStore.getState().setPluginTeams(teams);
    });
  };
  const unsubscribePlugins = usePluginStore.subscribe((state, previous) => {
    if (state.installed !== previous.installed || state.activationByKey !== previous.activationByKey || state.activationReady !== previous.activationReady) refresh();
  });
  const unsubscribeLanguage = subscribeLanguage(refresh);
  refresh();
  return () => {
    unsubscribePlugins();
    unsubscribeLanguage();
  };
}
