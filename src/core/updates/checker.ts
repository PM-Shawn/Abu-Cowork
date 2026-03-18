/**
 * Update Checker Module
 * Checks for new versions from GitHub Releases API.
 */

import { fetch } from '@tauri-apps/plugin-http';
import { APP_VERSION } from '@/utils/version';
import { getPlatform } from '@/utils/platform';
import { useSettingsStore } from '@/stores/settingsStore';

const GITHUB_OWNER = 'PM-Shawn';
const GITHUB_REPO = 'Abu-Cowork';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

// 24 hours in milliseconds
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateInfo {
  version: string;
  releaseNotes: string;
  publishedAt: string;
  downloadUrl: string;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  body: string;
  published_at: string;
  html_url: string;
  assets: GitHubAsset[];
}

/**
 * Simple semver comparison: returns true if remote > local.
 * Compares major.minor.patch segments numerically.
 */
function isNewerVersion(remote: string, local: string): boolean {
  const r = remote.replace(/^v/, '').split('.').map(Number);
  const l = local.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const rv = r[i] ?? 0;
    const lv = l[i] ?? 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

/**
 * Pick the best download URL from GitHub Release assets for the current platform.
 * Falls back to the release page URL if no matching asset is found.
 */
function pickDownloadUrl(release: GitHubRelease): string {
  const platform = getPlatform();
  const assets = release.assets;

  if (platform === 'macos') {
    // Prefer .dmg, then .app.tar.gz
    const dmg = assets.find((a) => a.name.endsWith('.dmg'));
    if (dmg) return dmg.browser_download_url;
    const tarball = assets.find((a) => a.name.endsWith('.app.tar.gz'));
    if (tarball) return tarball.browser_download_url;
  }

  if (platform === 'windows') {
    // Prefer .msi, then .exe
    const msi = assets.find((a) => a.name.endsWith('.msi'));
    if (msi) return msi.browser_download_url;
    const exe = assets.find((a) => a.name.endsWith('.exe'));
    if (exe) return exe.browser_download_url;
  }

  // Fallback: open the release page in browser
  return release.html_url;
}

/**
 * Check for updates via GitHub Releases API.
 * Returns UpdateInfo if a newer version is available, null otherwise.
 * Respects a 24-hour throttle for automatic checks (pass force=true to bypass).
 */
export async function checkForUpdate(force = false): Promise<UpdateInfo | null> {
  const store = useSettingsStore.getState();

  // Throttle: skip if checked within the last 24 hours (unless forced)
  if (!force) {
    const elapsed = Date.now() - store.lastUpdateCheck;
    if (elapsed < CHECK_INTERVAL_MS) {
      return null;
    }
  }

  store.setUpdateChecking(true);

  try {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(GITHUB_API_URL, {
        method: 'GET',
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': `${GITHUB_REPO}/${APP_VERSION}`,
        },
        connectTimeout: 10000,
      });
    } catch {
      // Network/DNS errors — silently skip
      return null;
    }

    if (!response.ok) {
      console.warn(`[Update] Check failed: HTTP ${response.status}`);
      return null;
    }

    const release = (await response.json()) as GitHubRelease;

    // Update the last check timestamp
    store.setLastUpdateCheck(Date.now());

    const remoteVersion = release.tag_name;
    if (!isNewerVersion(remoteVersion, APP_VERSION)) {
      store.setUpdateInfo(null);
      return null;
    }

    const info: UpdateInfo = {
      version: remoteVersion.replace(/^v/, ''),
      releaseNotes: release.body ?? '',
      publishedAt: release.published_at,
      downloadUrl: pickDownloadUrl(release),
    };

    store.setUpdateInfo(info);
    return info;
  } catch (err) {
    console.warn('[Update] Check failed:', err);
    return null;
  } finally {
    store.setUpdateChecking(false);
  }
}
