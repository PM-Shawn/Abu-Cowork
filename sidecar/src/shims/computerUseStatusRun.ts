/**
 * Sidecar-local replacement for `src/core/agent/computerUseStatus.ts`.
 *
 * Export surface verified against actual consumers, not the real module's
 * full surface: `grep -n "computerUseStatus" src/core/agent/{agentLoop,
 * toolExecutor,eventRouter}.ts` shows `toolExecutor.ts` imports exactly 6
 * names (`setComputerUseActive`, `incrementComputerUseStep`,
 * `setCurrentAction`, `isSessionWindowHidden`, `setSessionWindowHidden`,
 * `pauseComputerUseStatus`); `agentLoop.ts` only reaches
 * `setComputerUseActive` via a dynamic `import('./computerUseStatus')`.
 * `updateLatestScreenshot`/`checkCUSessionLimits`/`subscribeCUStatus`/
 * `getCUStatusSnapshot` are consumed ONLY by
 * `src/core/tools/definitions/computerTools.ts` (part of the
 * `tools/builtins.ts` DRAGGER cluster, never bundled sidecar-side — tool
 * execution always reverses via `tool.invoke`), so they're omitted here
 * rather than speculatively stubbed.
 *
 * ── State-SETTER exports → real forwarding shim (`cu.setState`) ─────────
 * All 5 setters forward as the `cu.setState` NOTIFICATION `{ action, args }`,
 * where `action` is one of the 7-entry allowlist verified against
 * `src/core/agent/agentLoopRunner.ts`'s `CU_SET_STATE_ACTIONS` record (NOT
 * just the design doc's prose) — 5 of those 7 entries
 * (`setComputerUseActive`/`setCurrentAction`/`incrementComputerUseStep`/
 * `pauseComputerUseStatus`/`setSessionWindowHidden`) map to this module's
 * real functions on the shell side; the other 2
 * (`setComputerUseBatchMode`/`setSkipAutoScreenshot`) belong to
 * `builtinsRun.ts` (see that file). The REAL shell-side `computerUseStatus.ts`
 * runs unchanged and does the real work (window hide/show, overlay events,
 * abort-listener wiring) when these arrive.
 *
 * ── `isSessionWindowHidden` (a READ) → sidecar-local mirror boolean ─────
 * Maintained by this SAME shim's `setSessionWindowHidden`/
 * `setComputerUseActive` calls (see below for why `setComputerUseActive`
 * ALSO writes it) — never round-trips to the shell (matches
 * `toolExecutor.ts:299`'s synchronous, hot-path usage:
 * `if (hasInteractiveAction && !isSessionWindowHidden())`).
 *
 * `setComputerUseActive(false, ...)` ALSO resets the local mirror to
 * `false` — this mirrors a real, verified side effect of the SHELL-side
 * function (`computerUseStatus.ts`'s own `update({ ..., sessionWindowHidden:
 * false, ... })` inside the `else` branch), not a guess. Read the real
 * function body before implementing this.
 *
 * ── ⚠️ FINDING (evidence-based, not silently assumed away): local mirror
 * CAN drift stale-`true` after a user-initiated Stop ─────────────────────
 * `grep -rn "setSessionWindowHidden(\|setComputerUseActive(" src --include
 * "*.ts" --include "*.tsx"` surfaces a THIRD caller beyond
 * `toolExecutor.ts`/`computerUseStatus.ts` itself:
 * `src/stores/chatStore.ts:1254`'s `cancelStreaming(convId)` — the "Stop"
 * button's handler — calls `setComputerUseActive(false)` DIRECTLY on the
 * REAL shell-side module (chatStore.ts is shell-only, never reaches the
 * sidecar bundle) and separately restores the window/border via a raw
 * `invoke('hide_screen_border')`/`invoke('window_show')`, all WITHOUT going
 * through `cu.setState` (there is no shell→sidecar push channel for this
 * flag — `cu.setState` is sidecar→shell only). So: if a user hits Stop while
 * a sidecar-run main loop has `sessionWindowHidden === true` locally, the
 * SHELL resets its real state to `false` and restores the window, but this
 * shim's local mirror is never told — it stays stale `true` until the next
 * `setSessionWindowHidden`/`setComputerUseActive` call from THIS process.
 * Practical blast radius: narrow — the loop is aborting (its own
 * `AgentRunContext.abortRegistry` controller fires), so any in-flight
 * `toolExecutor.ts` tool batch that still reads the stale mirror before the
 * loop fully unwinds could skip a redundant show-border call it would
 * otherwise have made; it cannot re-hide an already-shown window (the
 * mirror only gates SHOWING, never hiding). Not fixed here — would need
 * either a new shell→sidecar push for this flag or `agentLoop.ts`'s own
 * abort-cleanup path to reset it, both out of this card's shim-file scope.
 * Flagged per P1-3B-2-REPORT.md §5b's identical evidentiary standard.
 */
import { sendNotification } from '../rpcClient';

let sessionWindowHidden = false;

function setState(action: string, ...args: unknown[]): void {
  sendNotification('cu.setState', { action, args });
}

export function setComputerUseActive(active: boolean, conversationId?: string): void {
  if (!active) {
    // Mirrors the real module's side effect — see module doc.
    sessionWindowHidden = false;
  }
  setState('setComputerUseActive', active, conversationId);
}

export function pauseComputerUseStatus(): void {
  setState('pauseComputerUseStatus');
}

export function incrementComputerUseStep(action?: string): void {
  setState('incrementComputerUseStep', action);
}

export function setSessionWindowHidden(hidden: boolean): void {
  sessionWindowHidden = hidden;
  setState('setSessionWindowHidden', hidden);
}

export function isSessionWindowHidden(): boolean {
  return sessionWindowHidden;
}

export function setCurrentAction(action: string | null): void {
  setState('setCurrentAction', action);
}
