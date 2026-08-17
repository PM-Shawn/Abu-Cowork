/**
 * Renderer end of the shell crash channel.
 *
 * The Electron main process observes its own uncaught exceptions/rejections
 * and renderer deaths, and writes each one to the local runtime-observability
 * log itself (electron/runtimeObservability.cjs). It cannot decide whether the
 * user allows remote reporting, though — the telemetry opt-out and the
 * enterprise console target both live in renderer stores. So main forwards
 * severe crashes here as a `runtime-crash` event and this module makes the
 * report through the normal opt-out-checked path.
 *
 * Reach: this only covers crashes a LIVE renderer can still hear about. A
 * main-process exception qualifies (Electron keeps running and shows its
 * dialog), and so does a secondary window dying. The main window killing its
 * own renderer does not — that record stays local, readable from the offline
 * diagnostic export.
 */
import { listen } from '@tauri-apps/api/event';
import { reportError } from '@/utils/consoleError';
import type { ConsoleErrorType } from '@/utils/consoleError';

export const SHELL_CRASH_EVENT = 'runtime-crash';

export type ShellCrashKind =
  | 'main_uncaught_exception'
  | 'main_unhandled_rejection'
  | 'renderer_process_gone';

export interface ShellCrashReport {
  kind: ShellCrashKind;
  /** Error class (main-process crashes) or a fixed classifier (renderer death). */
  errorType: string;
  /** `uncaughtException` origin, or the Electron render-process-gone reason. */
  reason?: string;
  /** Already redacted and length-bounded by the main process. */
  message?: string;
  windowLabel?: string;
}

const REMOTE_ERROR_TYPE: Record<ShellCrashKind, ConsoleErrorType> = {
  main_uncaught_exception: 'main_crash',
  main_unhandled_rejection: 'main_crash',
  renderer_process_gone: 'renderer_crash',
};

/** Exported for tests; production code goes through subscribeShellCrashReports. */
export function handleShellCrashReport(payload: unknown): void {
  if (payload == null || typeof payload !== 'object') return;
  const crash = payload as Partial<ShellCrashReport>;
  const remoteType = typeof crash.kind === 'string'
    ? REMOTE_ERROR_TYPE[crash.kind as ShellCrashKind]
    : undefined;
  if (!remoteType) return;

  // errorCode keeps the classification (error class or crash reason); the
  // message is whatever main already redacted. reportError() resolves the
  // telemetry target, which returns disabled when the user opted out.
  reportError(
    remoteType,
    typeof crash.errorType === 'string' ? crash.errorType : 'unknown',
    undefined,
    undefined,
    typeof crash.message === 'string' && crash.message !== '' ? crash.message : crash.reason,
  );
}

export function subscribeShellCrashReports(): Promise<() => void> {
  return listen<ShellCrashReport>(SHELL_CRASH_EVENT, (event) => {
    handleShellCrashReport(event.payload);
  });
}
