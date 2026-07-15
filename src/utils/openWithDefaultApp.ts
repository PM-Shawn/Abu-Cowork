import { openPath } from '@tauri-apps/plugin-opener';

/**
 * Open a file with the OS default application (uses the opener plugin,
 * whose `opener:allow-open-path` capability is scoped to $HOME/** etc.).
 * Throws on failure so the caller can surface a toast — never swallow.
 */
export async function openWithDefaultApp(filePath: string): Promise<void> {
  await openPath(filePath);
}
