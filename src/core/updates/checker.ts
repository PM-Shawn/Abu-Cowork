import { Update } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { useSettingsStore } from '@/stores/settingsStore';
import { publish } from '@/core/notice/bus';
import { getLocale } from '@/i18n';
import type { UpdateDownloadProgress, UpdateInfo } from './types';

export type { UpdateDownloadProgress, UpdateInfo } from './types';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Release metadata feed published to OSS by the release pipeline
// (scripts/website-release-metadata.mjs → electron/latest-release.json). It
// carries the per-locale `notes_i18n` field the electron-updater feed
// (latest-mac.yml) does not. The same feed also backs the website homepage.
// NOTE: this is NOT the frozen Tauri-era `latest.json` (that manifest stopped
// updating after v0.34.x); this one tracks every release.
const RELEASE_METADATA_URL = 'https://abu-agent.oss-cn-beijing.aliyuncs.com/electron/latest-release.json';

let _pendingUpdate: Update | null = null;

/**
 * Raw result of `plugin:updater|check`. The Electron host (updaterHost.cjs) is
 * three-state where Tauri's plugin was only two:
 *  - metadata → newer version available;
 *  - null     → the feed was actually queried and this version is current;
 *  - `{ status: 'disabled', reason }` → the updater never armed in this build
 *    (non-official/fork package, or dev shell without a feed).
 * We invoke the command directly instead of going through the plugin's
 * `check()` wrapper, because that wrapper blindly wraps any truthy result in
 * an `Update` — it cannot carry the disabled marker. Legacy Tauri builds never
 * produce the marker, so this stays backward compatible.
 */
interface UpdateCheckMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
}

interface UpdaterDisabledMarker {
  status: 'disabled';
  reason?: string;
}

function isUpdaterDisabledMarker(v: unknown): v is UpdaterDisabledMarker {
  return typeof v === 'object' && v !== null && (v as { status?: unknown }).status === 'disabled';
}

interface ElectronProgressData {
  total?: number;
  transferred?: number;
}

function toNonNegativeFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function setDownloadProgress(progress: UpdateDownloadProgress): void {
  useSettingsStore.getState().setUpdateDownloadProgress(progress);
}

/**
 * Pick release notes in the user's UI language. The release metadata feed
 * (`electron/latest-release.json`) carries `notes_i18n: { "zh-CN": ..., "en-US":
 * ... }`. The electron-updater feed (`latest-mac.yml`) carries no release notes,
 * so `update.body` is typically empty — we read BOTH languages from this feed
 * (not just Chinese), otherwise English users would see an empty changelog.
 *
 * 🔴 Version guard: this metadata feed is a SEPARATE file from the
 * electron-updater feed that produced `expectedVersion`. The same release
 * publishes both, but they could momentarily disagree (a partially completed or
 * superseded release, or CDN caching). When they disagree, the metadata's notes
 * describe a *different* version, so we fall back to the updater's own body
 * rather than show the wrong changelog (a zh-CN user offered vNEW must not read
 * vOLD's notes). An unexpected `schema_version`, a missing locale, or any
 * failure (offline, empty notes) also falls back — never worse than before.
 */
async function localizedNotes(fallback: string, expectedVersion: string): Promise<string> {
  const locale = getLocale();
  try {
    const res = await fetch(RELEASE_METADATA_URL, { cache: 'no-cache' });
    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      schema_version?: number;
      version?: string;
      notes_i18n?: Record<string, string>;
    };
    if (data.schema_version !== 1) return fallback;
    const metaVersion = data.version?.replace(/^v/, '').trim();
    if (metaVersion && metaVersion !== expectedVersion) return fallback;
    // Prefer the user's locale; fall back to the feed's English notes (always
    // present) before the empty updater body, mirroring the website homepage.
    const localized = (data.notes_i18n?.[locale] ?? data.notes_i18n?.['en-US'] ?? '').trim();
    return localized.length > 0 ? localized : fallback;
  } catch {
    return fallback;
  }
}

// When OSS latest.json body is just "See {github-url}", fetch the real body from GitHub API.
async function enrichReleaseNotes(rawNotes: string): Promise<{ notes: string; url: string }> {
  const urlMatch = rawNotes.match(/https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/releases\/tag\/([^\s)]+)/);
  if (!urlMatch) return { notes: rawNotes, url: '' };

  const [releaseUrl, owner, repo, tag] = urlMatch;

  // If there's meaningful content beyond the URL, keep it.
  const stripped = rawNotes.replace(releaseUrl, '').replace(/^See\s*/i, '').trim();
  if (stripped.length > 20) return { notes: rawNotes, url: releaseUrl };

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return { notes: rawNotes, url: releaseUrl };
    const data = await res.json() as { body?: string };
    const body = data.body?.trim() ?? '';
    // Only use API body if it's richer than the original
    if (body && body.length > stripped.length + 10) {
      return { notes: body, url: releaseUrl };
    }
  } catch {
    // ignore — fall back to raw notes
  }

  return { notes: rawNotes, url: releaseUrl };
}

/**
 * @param opts.silent Perform the check WITHOUT touching the global update UI:
 *   skip the `updateChecking` spinner flag (bound by AboutSection/AccountMenu)
 *   and skip the `update_available` notification. `updateInfo` and
 *   `lastUpdateCheck` are still written so callers reading store state (e.g. the
 *   diagnostic app-check) see the result. Use when a background/observer caller
 *   wants the data but must not surface update UI to the user.
 */
export async function checkForUpdate(
  force = false,
  opts: { silent?: boolean } = {},
): Promise<UpdateInfo | null> {
  const store = useSettingsStore.getState();
  const { silent = false } = opts;

  if (!force) {
    const elapsed = Date.now() - store.lastUpdateCheck;
    if (elapsed < CHECK_INTERVAL_MS) return null;
  }

  if (!silent) store.setUpdateChecking(true);

  try {
    const raw = await invoke<UpdateCheckMetadata | UpdaterDisabledMarker | null>(
      'plugin:updater|check',
      {},
    );

    if (isUpdaterDisabledMarker(raw)) {
      // Updater never armed in this build — no feed was contacted, so this is
      // NOT "up to date". Record the fact for the About/AccountMenu captions
      // and the diagnostic app-check, and leave `lastUpdateCheck` untouched
      // (see the invariant below): the 6h throttle then never suppresses the
      // startup check on such builds, so the flag is re-learned each session.
      store.setUpdaterUnsupported(true);
      store.setUpdateInfo(null);
      _pendingUpdate = null;
      return null;
    }
    store.setUpdaterUnsupported(false);

    // Invariant relied on by the diagnostic app-check (core/diagnostic/checks/
    // app.ts): `lastUpdateCheck` is advanced ONLY after the check actually
    // resolved with a feed answer — i.e. the server was reached. A thrown
    // check skips straight to the catch below WITHOUT advancing it, and the
    // disabled marker returns above it — that is how the diagnostic
    // distinguishes "confirmed up to date" from "could not reach the update
    // feed" and "updater disabled". Do not move this above the invoke.
    store.setLastUpdateCheck(Date.now());

    const update = raw ? new Update(raw) : null;

    if (!update) {
      store.setUpdateInfo(null);
      _pendingUpdate = null;
      return null;
    }

    _pendingUpdate = update;

    const normalizedVersion = update.version.replace(/^v/, '').trim();
    const localized = await localizedNotes(update.body ?? '', normalizedVersion);
    const { notes, url } = await enrichReleaseNotes(localized);

    const info: UpdateInfo = {
      version: normalizedVersion,
      releaseNotes: notes,
      releaseUrl: url,
      publishedAt: update.date ?? '',
    };

    store.setUpdateInfo(info);

    if (!silent) {
      publish({
        type: 'update_available',
        source: 'core',
        payload: { version: info.version, releaseUrl: info.releaseUrl },
        // dedupKey includes version so each release only notifies once
        dedupKey: `update_available:${info.version}`,
      });
    }

    return info;
  } catch (err) {
    console.warn('[Update] Check failed:', err);
    return null;
  } finally {
    if (!silent) store.setUpdateChecking(false);
  }
}

/**
 * Re-resolve the pending update's release notes for the CURRENT UI locale and
 * write them back to the store. `checkForUpdate()` resolves notes in whichever
 * locale was active at check time; when the user switches language afterwards,
 * call this so the update dialog follows the new language without forcing a
 * fresh version check. No-ops when there is no pending update / prior result.
 */
export async function refreshUpdateNotes(): Promise<void> {
  if (!_pendingUpdate) return;
  const store = useSettingsStore.getState();
  const current = store.updateInfo;
  if (!current) return;

  const normalizedVersion = _pendingUpdate.version.replace(/^v/, '').trim();
  const localized = await localizedNotes(_pendingUpdate.body ?? '', normalizedVersion);
  const { notes, url } = await enrichReleaseNotes(localized);
  // Only the locale-dependent fields change; keep version/publishedAt intact.
  store.setUpdateInfo({ ...current, releaseNotes: notes, releaseUrl: url });
}

export async function downloadAndInstallUpdate(): Promise<void> {
  if (!_pendingUpdate) throw new Error('No pending update');

  const store = useSettingsStore.getState();

  // Give immediate feedback before the updater opens the connection or emits
  // its first byte event. Slow DNS/proxy/TLS setup must not look like a dead
  // click or a frozen 0% progress bar.
  store.setUpdateInstalling(false);
  setDownloadProgress({ phase: 'preparing', downloaded: 0, total: 0 });

  try {
    let downloaded = 0;
    let contentLength = 0;

    await _pendingUpdate.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          contentLength = toNonNegativeFinite(event.data.contentLength) ?? 0;
          downloaded = 0;
          setDownloadProgress({ phase: 'downloading', downloaded, total: contentLength });
          break;
        case 'Progress': {
          // The Electron bridge includes absolute counters in addition to the
          // Tauri-compatible chunkLength. Prefer them so throttled/coalesced
          // progress callbacks cannot make the UI drift behind the real file.
          const electronData = event.data as typeof event.data & ElectronProgressData;
          const reportedTotal = toNonNegativeFinite(electronData.total);
          const reportedTransferred = toNonNegativeFinite(electronData.transferred);
          const chunkLength = toNonNegativeFinite(event.data.chunkLength) ?? 0;

          // A zero total means "unknown". Do not let a later incomplete
          // Electron event erase a valid total received in Started.
          if (reportedTotal !== null && reportedTotal > 0) contentLength = reportedTotal;
          downloaded = reportedTransferred ?? downloaded + chunkLength;
          if (contentLength > 0) downloaded = Math.min(downloaded, contentLength);

          const phase = contentLength > 0 && downloaded >= contentLength
            ? 'verifying'
            : 'downloading';
          setDownloadProgress({ phase, downloaded, total: contentLength });
          break;
        }
        case 'Finished':
          // electron-updater verifies hashes/signatures before resolving. Keep
          // the UI alive through that final hand-off instead of briefly hiding
          // the progress row between download and restart-ready states.
          setDownloadProgress({
            phase: 'verifying',
            downloaded: contentLength > 0 ? contentLength : downloaded,
            total: contentLength,
          });
          break;
      }
    });

    store.setUpdateDownloadProgress(null);
    store.setUpdateInstalling(true);
  } catch (err) {
    store.setUpdateDownloadProgress(null);
    store.setUpdateInstalling(false);
    throw err;
  }
}

export async function restartApp(): Promise<void> {
  await relaunch();
}
