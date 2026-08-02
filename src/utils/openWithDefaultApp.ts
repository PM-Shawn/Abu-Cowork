import { openPath } from '@tauri-apps/plugin-opener';

/**
 * Open a file with the OS default application.
 *
 * The capability-scoped opener is the only path. Do not interpolate an
 * untrusted filesystem path into a shell command as a fallback; callers
 * surface its error and can ask the user to open the file manually.
 */
export async function openWithDefaultApp(filePath: string): Promise<void> {
  await openPath(filePath);
}
