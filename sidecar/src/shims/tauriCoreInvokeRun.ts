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

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const runId = agentRunContext.getStore()?.runId ?? subagentRunContext.getStore()?.runId;
  if (!runId) {
    throw new Error('[sidecar] native.invoke called outside an agent/subagent run context');
  }
  return sendRequest('native.invoke', { runId, cmd, args }) as Promise<T>;
}
