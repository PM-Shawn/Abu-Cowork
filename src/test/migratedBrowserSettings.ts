import { useSettingsStore, type SettingsState } from '@/stores/settingsStore';
import { migrateBrowserPermissionConfig } from '@/core/permissions/browserPermissionConfig';

/** Arrange an upgraded user's confirmed V53 settings for existing gate fixtures.
 * Legacy values are migration INPUT only; the runtime sees exactly one V2 model.
 * Persistence races are covered by settingsStore.browserPermissions.test.ts.
 */
export function setMigratedBrowserSettings(patch: Partial<SettingsState>): void {
  const state = { ...useSettingsStore.getState(), ...patch };
  const config = Object.hasOwn(patch, 'browserPermissionConfigV2') ? patch.browserPermissionConfigV2
    : migrateBrowserPermissionConfig({ ...state, browserPermissionConfigV2: undefined });
  localStorage.setItem('abu-settings', JSON.stringify({ version: 53, state: { ...state, browserPermissionConfigV2: config } }));
  useSettingsStore.setState({ ...patch, browserPermissionConfigV2: config });
}
