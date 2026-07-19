/**
 * Sidecar-local replacement for `src/core/agent/lifecycleHooks.ts`.
 *
 * The real module's import graph is itself bundle-safe (zero imports — see
 * P1-3a-pre-REPORT.md §3's `lifecycleHooks` row) — the problem isn't
 * bundling, it's BEHAVIOR: its listeners are registered by webview-side UI
 * code (notification panel, todo panel, skill hooks, ...). A sidecar-
 * resident `emitHook()` calling the REAL module would only ever reach
 * listeners registered inside the (headless, UI-less) sidecar process —
 * i.e. none of them — silently dropping every hook event. This shim
 * instead forwards each event back to the shell over the reverse-RPC
 * channel, where the REAL `emitHook()` (with the REAL listeners) runs —
 * see `subagentRunner.ts`'s `handleHookEmit`/`handleHookNotify`.
 *
 * Request vs notification split — see subagentRunner.ts's "Hooks verdict"
 * doc comment for the full reasoning: only `preToolCall` has its return
 * value consumed by `subagentLoop.ts` (block/modify), so it alone pays for
 * a round-trip; everything else is fire-and-forget.
 */
import { sendRequest, sendNotification } from '../rpcClient';
import { getCurrentSubagentRunContext } from '../subagentRunContext';
import type { HookEvent } from '@/core/agent/lifecycleHooks';

export function emitHook<T extends HookEvent>(event: T): T | Promise<T> {
  const { runId } = getCurrentSubagentRunContext();

  if (event.type === 'preToolCall') {
    return sendRequest('hook.emit', { runId, event }) as Promise<T>;
  }

  sendNotification('hook.notify', { runId, event });
  return event;
}
