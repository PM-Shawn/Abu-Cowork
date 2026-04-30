/**
 * App check — version + update status. Read-only against settingsStore;
 * does not actively call the update endpoint (the update check has its
 * own 6h cadence, see core/updates/checker.ts).
 */

import { APP_VERSION } from '@/utils/version';
import { useSettingsStore } from '@/stores/settingsStore';
import { getI18n } from '@/i18n';
import type { CheckResult } from '../types';

export function runAppChecks(): CheckResult[] {
  const t = getI18n();
  const updateInfo = useSettingsStore.getState().updateInfo;

  // No updateInfo means either the check hasn't fired yet OR no newer version
  // is available. checker.ts sets updateInfo only when newer version exists.
  const upToDate = !updateInfo;

  return [{
    id: 'app:version',
    category: 'app',
    name: t.diagnostic.appVersion,
    status: upToDate ? 'passed' : 'warning',
    metric: upToDate
      ? `v${APP_VERSION} · ${t.diagnostic.appLatest}`
      : t.diagnostic.appUpdateAvailable.replace('{version}', updateInfo.version),
    suggestedAction: upToDate ? undefined : {
      type: 'open-settings',
      target: 'about',
      label: t.diagnostic.actionOpenAbout,
    },
    checkedAt: Date.now(),
    durationMs: 0,
  }];
}
