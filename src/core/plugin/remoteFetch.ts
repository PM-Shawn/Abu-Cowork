/**
 * Renderer-side entry to the privileged remote-git fetcher.
 *
 * The renderer never touches git or the network itself — it names a source and
 * a destination and asks the main process (`plugin_git_fetch`, handled by
 * `electron/pluginGitHost.cjs`) to clone, sha-verify, and land the package.
 * Both arguments are re-validated on the privileged side; this wrapper is a
 * thin, typed call, not a trust boundary.
 */

import { invoke } from '@tauri-apps/api/core';
import type { PluginSource } from './marketplace';

export interface RemoteFetchResult {
  /** Absolute directory the verified package now lives in. */
  destDir: string;
  /** The sha that was checked out and asserted. */
  sha: string;
}

/**
 * Fetch a remote (`url` / `git-subdir`) plugin source into `destDir`.
 *
 * `destDir` must resolve inside the plugin-packages root; the main process
 * rejects anything else. Rejects on unsafe url, missing sha, sha mismatch,
 * clone failure, or timeout.
 */
export async function fetchRemotePluginSource(
  source: PluginSource,
  destDir: string,
): Promise<RemoteFetchResult> {
  return invoke<RemoteFetchResult>('plugin_git_fetch', { source, destDir });
}
