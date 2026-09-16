/**
 * Sidecar-local replacement for `@tauri-apps/api/core`.
 *
 * REAL forwarding shim for the `invoke` export specifically. Consumers
 * verified by grep, not assumed: `src/core/skill/preprocessor.ts` makes
 * exactly ONE `invoke` call (`invoke<CommandOutput>('run_shell_command',
 * {...})`, inline-command execution for skill prompts); `toolExecutor.ts`
 * makes 4 (`show_screen_border`, `get_active_window` — via
 * `invoke<{app_name:string}>('get_active_window')`, easy to miss with a
 * naive `invoke('` grep, confirmed by grepping `invoke(` bare — `window_hide`,
 * `activate_app`). All 5 command-name literals match
 * `src/core/agent/agentLoopRunner.ts`'s `NATIVE_INVOKE_ALLOWLIST` exactly
 * (verified against the actual code, not just P1-3B-2-REPORT.md's prose).
 * `computerUseStatus.ts` also has a dynamic `import('@tauri-apps/api/core')`
 * call for `invoke('window_show')`/`invoke('hide_screen_border')`, but that
 * whole module is redirected wholesale to `computerUseStatusRun.ts` (§6), so
 * this specific call site never actually reaches this shim at runtime.
 *
 * `invoke(cmd, args)` forwards as the `native.invoke` REQUEST — verified
 * against `agentLoopRunner.ts`'s `handleNativeInvoke`: params
 * `{ runId: string, cmd: string, args?: Record<string, unknown> }`, response
 * is whatever the real Tauri `invoke(cmd, args)` resolved to shell-side. The
 * ambient runId lets the shell retain the owning run until the native request
 * settles. Fail-closed
 * server-side (an unlisted `cmd` is REJECTED by the shell handler, not
 * silently forwarded) — this shim does not duplicate that allowlist
 * client-side; it just forwards and lets the shell enforce it once, in one
 * place (avoids the two lists drifting out of sync).
 *
 * ── Other `@tauri-apps/api/core` exports ─────────────────────────────────
 * Grepped every reachable file (`toolExecutor.ts`, `preprocessor.ts`,
 * `agentLoop.ts`, `eventRouter.ts`, `computerUseStatus.ts`,
 * `permissionBridge.ts`) for `@tauri-apps/api/core` imports — only `invoke`
 * is ever named. `Channel`/`transformCallback`/`convertFileSrc`/etc. are not
 * imported anywhere reachable, so they're intentionally NOT stubbed —
 * adding them speculatively would be dead code with no way to verify
 * correctness. If a future edit adds a reachable import of one of those,
 * esbuild will fail loudly at `npm run build:sidecar` time (missing export
 * from this redirect target) rather than silently resolving to `undefined`.
 */
import { sendRequest } from '../rpcClient';
import { agentRunContext } from '../agentRunContext';
import { subagentRunContext } from '../subagentRunContext';

const CLEANUP_COMMANDS: ReadonlySet<string> = new Set([
  'abort_command',
  'ax_close_session',
  'computer_use_end_task',
]);

/**
 * Cleanup-only fallback for callbacks that already captured their owning
 * runId but execute without an ambient AsyncLocalStorage store. The shell
 * still validates both the run owner and its native-command allowlist.
 */
export async function invokeCleanupForCapturedRun<T>(
  runId: string,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!runId || !CLEANUP_COMMANDS.has(cmd)) {
    throw new Error(`[sidecar] explicit native.invoke owner override is restricted to cleanup commands: ${cmd}`);
  }
  console.error('[sidecar:native.invoke] cleanup dispatch used an explicit captured run owner', { runId, cmd });
  return sendRequest('native.invoke', { runId, cmd, args }) as Promise<T>;
}

/**
 * Mirrors `@tauri-apps/api/core`'s `InvokeArgs`. Only the record form can
 * cross the `native.invoke` JSON wire — the binary forms are accepted here
 * solely so they are REJECTED loudly instead of being stringified into an
 * object with numeric keys.
 */
export type InvokeArgsLike = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array;

/**
 * The real `invoke` is `(cmd, args?: InvokeArgs, options?: InvokeOptions)`.
 * This shim used to declare two parameters and a narrower `args`, so a third
 * argument was silently discarded and a binary payload would have been
 * JSON-serialized into a numeric-keyed object. Both are now rejected; the
 * checks run BEFORE the run-context check so a malformed call fails the same
 * way inside or outside a run.
 */
export async function invoke<T>(cmd: string, args?: InvokeArgsLike, options?: unknown): Promise<T> {
  if (options !== undefined) {
    throw new Error(`[sidecar] native.invoke does not support InvokeOptions (headers): ${cmd}`);
  }
  if (args !== undefined && (Array.isArray(args) || args instanceof ArrayBuffer || ArrayBuffer.isView(args))) {
    throw new Error(`[sidecar] native.invoke args must be a plain record, not a binary payload: ${cmd}`);
  }
  const runId = agentRunContext.getStore()?.runId ?? subagentRunContext.getStore()?.runId;
  if (!runId) {
    throw new Error('[sidecar] native.invoke called outside an agent/subagent run context');
  }
  return sendRequest('native.invoke', { runId, cmd, args }) as Promise<T>;
}
