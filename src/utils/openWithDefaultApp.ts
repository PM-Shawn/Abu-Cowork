import { openPath } from '@tauri-apps/plugin-opener';

/**
 * Error message of an open the main process refused because the system would run the file
 * (`electron/openPathPolicy.cjs` throws it). Electron IPC keeps only `message`.
 */
export const OPEN_REFUSED_RUNS_BY_DEFAULT = 'open-refused:runs-by-default';

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

/** Whether a failed open is the main process's refusal: the caller then offers the file manager. */
export function isRunByDefaultRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return message.includes(OPEN_REFUSED_RUNS_BY_DEFAULT);
}
