/**
 * Sidecar-local replacement for `src/core/sandbox/recovery.ts`.
 *
 * REAL forwarding shim (same shape as `notificationsRun.ts` — see that
 * file's doc for the general pattern this mirrors) — the real module's
 * `showSandboxBlockedToast` pushes onto `useToastStore` and reads
 * `useSettingsStore`/`getI18n()`, none of which exist in the sidecar
 * process. `commandTools.ts` (`run_command`) only ever calls the single
 * exported function `showSandboxBlockedToast(command)` (verified: `grep -n
 * "showSandboxBlockedToast\|extractBlockedPath" src/core/tools/definitions/commandTools.ts`
 * — one import, one call site, guarded by `if (sandbox &&
 * output.stderr.includes('[sandbox-blocked]'))`), so this shim covers
 * exactly that surface.
 *
 * Forwards to the shell via the `shell.sandboxBlocked` fire-and-forget
 * NOTIFICATION (shell handler: `agentLoopRunner.ts`'s
 * `handleShellSandboxBlocked`, which calls the REAL
 * `showSandboxBlockedToast(params.command)` — same real toast/authorize-path
 * recovery UI a shell-executed `run_command` would show).
 */
import { sendNotification } from '../rpcClient';

export function showSandboxBlockedToast(command: string): void {
  sendNotification('shell.sandboxBlocked', { command });
}
