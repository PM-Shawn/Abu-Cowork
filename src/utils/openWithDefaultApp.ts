import { openPath } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { getPlatform } from '@/utils/platform';

/**
 * Open a file with the OS default application.
 *
 * Primary: the opener plugin's `openPath()` — clean, capability-scoped API.
 * Its `opener:allow-open-path` allowlist (src-tauri/capabilities/default.json)
 * only covers `$HOME/**`, `/tmp/**`, `/Volumes/**`, `$TEMP/**`,
 * `/Applications/**`, etc. — a perfectly valid path outside those (a Windows
 * workspace on `D:\...`, a Linux mount under `/opt`) makes `openPath()` throw.
 *
 * Fallback: shell out via `open` / `xdg-open` / `start`, the same mechanism
 * this app used before adopting the opener plugin, so any valid path still
 * opens regardless of the allowlist. Only invoked when `openPath()` rejects.
 * If the fallback also fails, the *original* `openPath` error is rethrown so
 * the caller can surface a toast — never swallow both failures.
 */
export async function openWithDefaultApp(filePath: string): Promise<void> {
  try {
    await openPath(filePath);
  } catch (primaryErr) {
    try {
      const platform = getPlatform();
      const command = platform === 'windows'
        ? `start "" "${filePath}"`
        : platform === 'linux'
          ? `xdg-open "${filePath}"`
          : `open "${filePath}"`;
      await invoke('run_shell_command', {
        command,
        cwd: null,
        background: true,
        timeout: 5,
        sandboxEnabled: false,
      });
    } catch {
      throw primaryErr;
    }
  }
}
