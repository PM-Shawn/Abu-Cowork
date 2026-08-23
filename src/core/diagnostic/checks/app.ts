/**
 * App check — version + update status.
 *
 * Two independent facts are shown on one row:
 *  - The version NUMBER is always live: `APP_VERSION` is a compile-time
 *    constant baked from package.json (vite `__APP_VERSION__`), so it always
 *    reflects the running build. It is never read from the persisted
 *    diagnostic snapshot.
 *  - The up-to-date VERDICT is derived from an ACTIVE forced update check
 *    against the release feed (electron-updater `latest-mac.yml`), not from a
 *    passively-read cached flag. Diagnostic results are persisted
 *    (diagnosticStore), so a verdict computed from `updateInfo` alone would
 *    freeze at whatever it was the last time the panel ran — that is exactly
 *    the stale-snapshot bug where an updated app kept showing its old version
 *    and "已是最新". Forcing a real check here makes "已是最新" mean the feed
 *    was actually consulted just now, not merely "no update known this session".
 */

import { APP_VERSION } from '@/utils/version';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkForUpdate } from '@/core/updates/checker';
import { getI18n } from '@/i18n';
import type { CheckResult } from '../types';

/**
 * Upper bound on the forced update check. `runAll` only flips out of its
 * "checking" state once every category settles, so an unbounded network check
 * here could keep the whole diagnostic panel spinning behind a slow/unreachable
 * feed. Losing the race just means the timestamp below stays unchanged →
 * "无法检查更新", which is the honest outcome. Matches aiServices' 8s deadline.
 */
const UPDATE_CHECK_TIMEOUT_MS = 8000;

/** Resolve when `p` settles or after `ms`, whichever comes first; always clears
 *  its own timer so a fast winner can't leak a pending timeout into tests. */
function boundedWait(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([p.then(() => {}, () => {}), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function runAppChecks(): Promise<CheckResult[]> {
  const t = getI18n();
  const startedAt = Date.now();

  const before = useSettingsStore.getState().lastUpdateCheck;
  // force=true bypasses the 6h throttle so the verdict reflects a real, current
  // comparison. silent=true keeps this off the GLOBAL update UI — merely opening
  // diagnostics must NOT spin the About "check for updates" button or fire an
  // update notification; only the diagnostic row reads the result. Bounded so a
  // hanging feed can't stall the whole run.
  await boundedWait(checkForUpdate(true, { silent: true }), UPDATE_CHECK_TIMEOUT_MS);

  const state = useSettingsStore.getState();
  // checkForUpdate advances lastUpdateCheck ONLY after the check resolved with
  // a feed answer (see the invariant comment in checker.ts). An unchanged
  // timestamp therefore means the check did not complete — offline, updater
  // errored, or we hit the timeout above — so we must NOT claim the app is up
  // to date; say "couldn't check". Builds whose updater never armed
  // (non-official package / dev shell) are reported via the disabled marker →
  // `updaterUnsupported` below, checked FIRST because they also leave the
  // timestamp untouched.
  const checkReachedFeed = state.lastUpdateCheck !== before;
  const updateInfo = state.updateInfo;

  const base = {
    id: 'app:version',
    category: 'app' as const,
    name: t.diagnostic.appVersion,
    checkedAt: Date.now(),
    durationMs: Date.now() - startedAt,
  };

  if (state.updaterUnsupported) {
    return [{
      ...base,
      status: 'warning',
      metric: `v${APP_VERSION} · ${t.diagnostic.appUpdaterUnsupported}`,
    }];
  }

  if (!checkReachedFeed) {
    return [{
      ...base,
      status: 'warning',
      metric: `v${APP_VERSION} · ${t.diagnostic.appCheckFailed}`,
    }];
  }

  if (updateInfo) {
    return [{
      ...base,
      status: 'warning',
      metric: `v${APP_VERSION} · ${t.diagnostic.appUpdateAvailable.replace('{version}', updateInfo.version)}`,
      suggestedAction: {
        type: 'open-settings',
        target: 'about',
        label: t.diagnostic.actionOpenAbout,
      },
    }];
  }

  return [{
    ...base,
    status: 'passed',
    metric: `v${APP_VERSION} · ${t.diagnostic.appLatest}`,
  }];
}
