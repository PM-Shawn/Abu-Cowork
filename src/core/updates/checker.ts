import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useSettingsStore } from '@/stores/settingsStore';
import { publish } from '@/core/notice/bus';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface UpdateInfo {
  version: string;
  releaseNotes: string;
  releaseUrl: string;
  publishedAt: string;
}

let _pendingUpdate: Update | null = null;

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

    const { notes, url } = await enrichReleaseNotes(update.body ?? '');

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

  try {
    let downloaded = 0;
    let contentLength = 0;

    await _pendingUpdate.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          contentLength = event.data.contentLength ?? 0;
          store.setUpdateDownloadProgress({ downloaded: 0, total: contentLength });
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          store.setUpdateDownloadProgress({ downloaded, total: contentLength });
          break;
        case 'Finished':
          store.setUpdateDownloadProgress(null);
          break;
      }
    });

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
