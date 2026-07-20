/**
 * Sidecar-local replacement for `src/utils/notifications.ts`.
 *
 * REAL forwarding shim — the real module publishes through the Notice Bus
 * (`@/core/notice/bus`'s `publish()`), which routes to OS notification /
 * menubar / sidebar-badge channels via Tauri (`@tauri-apps/plugin-notification`)
 * and webview-only state (`@/core/notice/channels`'s dock-badge counter). None
 * of that exists in the sidecar process, so this shim forwards the two
 * functions `agentLoop.ts` actually imports (verified: `grep -n
 * "notifyTaskCompleted\|notifyTaskError" src/core/agent/agentLoop.ts` — only
 * these two names, 4 call sites, no other export of notifications.ts is
 * referenced) to the shell via the `shell.notifyTask` reverse NOTIFICATION,
 * where the REAL `notifyTaskCompleted`/`notifyTaskError` run (with the real
 * Notice Bus / OS notification / badge machinery).
 *
 * Payload shape verified against `src/core/agent/agentLoopRunner.ts`'s
 * `handleShellNotifyTask` (NOT just the design doc's prose):
 *   `{ kind: 'completed' | 'error', title: string, conversationId?: string }`
 * — `handleShellNotifyTask` requires `title` to be a string and dispatches
 * `notifyTaskCompleted(params.title, conversationId)` /
 * `notifyTaskError(params.title, conversationId)` on `kind === 'completed' |
 * 'error'`, matching the real functions' `(conversationTitle,
 * conversationId?)` signature exactly.
 */
import { sendNotification } from '../rpcClient';

export async function notifyTaskCompleted(conversationTitle: string, conversationId?: string): Promise<void> {
  sendNotification('shell.notifyTask', { kind: 'completed', title: conversationTitle, conversationId });
}

export async function notifyTaskError(conversationTitle: string, conversationId?: string): Promise<void> {
  sendNotification('shell.notifyTask', { kind: 'error', title: conversationTitle, conversationId });
}
