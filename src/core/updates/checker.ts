import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useSettingsStore } from '@/stores/settingsStore';
import { publish } from '@/core/notice/bus';
import { getLocale } from '@/i18n';
import type { UpdateDownloadProgress, UpdateInfo } from './types';

export type { UpdateDownloadProgress, UpdateInfo } from './types';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Same manifest the Tauri updater polls (tauri.conf.json → updater.endpoints).
// We refetch it directly to read the per-locale `notes_i18n` field, which the
// updater plugin doesn't expose (it only surfaces the top-level `notes`).
const LATEST_JSON_URL = 'https://abu-agent.oss-cn-beijing.aliyuncs.com/latest.json';

let _pendingUpdate: Update | null = null;

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
 * Pick release notes in the user's UI language. `latest.json` carries
 * `notes_i18n: { "zh-CN": ..., "en-US": ... }`; the top-level `notes` (what the
 * updater hands back as `update.body`) stays English for the updater default and
 * international users. English users already have the right text, so skip the
 * extra fetch. Any failure (offline, old manifest without `notes_i18n`, missing
 * locale) falls back to the English body — never worse than before.
 */
async function localizedNotes(fallback: string): Promise<string> {
  const locale = getLocale();
  if (locale === 'en-US') return fallback;
  try {
    const res = await fetch(LATEST_JSON_URL, { cache: 'no-cache' });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { notes_i18n?: Record<string, string> };
    const localized = data.notes_i18n?.[locale]?.trim();
    return localized && localized.length > 0 ? localized : fallback;
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

export async function checkForUpdate(force = false): Promise<UpdateInfo | null> {
  const store = useSettingsStore.getState();

  if (!force) {
    const elapsed = Date.now() - store.lastUpdateCheck;
    if (elapsed < CHECK_INTERVAL_MS) return null;
  }

  store.setUpdateChecking(true);

  try {
    const update = await check();
    store.setLastUpdateCheck(Date.now());

    if (!update) {
      store.setUpdateInfo(null);
      _pendingUpdate = null;
      return null;
    }

    _pendingUpdate = update;

    const localized = await localizedNotes(update.body ?? '');
    const { notes, url } = await enrichReleaseNotes(localized);

    const info: UpdateInfo = {
      version: update.version.replace(/^v/, ''),
      releaseNotes: notes,
      releaseUrl: url,
      publishedAt: update.date ?? '',
    };

    store.setUpdateInfo(info);

    publish({
      type: 'update_available',
      source: 'core',
      payload: { version: info.version, releaseUrl: info.releaseUrl },
      // dedupKey includes version so each release only notifies once
      dedupKey: `update_available:${info.version}`,
    });

    return info;
  } catch (err) {
    console.warn('[Update] Check failed:', err);
    return null;
  } finally {
    store.setUpdateChecking(false);
  }
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
