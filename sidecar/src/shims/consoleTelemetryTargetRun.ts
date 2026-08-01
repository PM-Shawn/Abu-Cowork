/**
 * Sidecar-local replacement for `src/utils/consoleTelemetryTarget.ts`.
 *
 * Legitimate NO-OP, same class of decision as `shims/langfuseRun.ts` (P1-3a
 * — "losing a trace... changes nothing the loop DOES, only what's observed
 * afterward"). Reached via `agentLoop.ts`'s bare `import { reportError }
 * from '@/utils/consoleError'` → `consoleError.ts`'s `getTelemetryTarget()`
 * call → the real module's `useEnterpriseStore.getState().mode` read (a
 * Zustand webview store, not importable sidecar-side).
 *
 * `getTelemetryTarget()` always returns `{ baseUrl: '', enabled: false }` —
 * the SAME shape the real module already returns for personal-mode installs
 * with no `VITE_CONSOLE_URL` configured (the open-source default — see the
 * real module's own doc comment). `consoleError.ts`'s `reportError()`
 * checks `if (!enabled) return;` BEFORE ever calling `fetch()`, so this is a
 * true no-op, not a broken fetch call. Net effect: enterprise-mode error
 * telemetry (an operational diagnostics feature, not agent behavior) simply
 * doesn't fire for sidecar-run main-loop errors this batch — a bounded,
 * documented degradation, not a correctness gap.
 */
export interface TelemetryTarget {
  baseUrl: string;
  enabled: boolean;
}

export function getTelemetryTarget(): TelemetryTarget {
  return { baseUrl: '', enabled: false };
}
