/**
 * Sidecar-local replacement for `src/core/tools/definitions/computerTools.ts`
 * — ONLY for `agentLoop.ts`'s DIRECT dynamic-import call sites (4, all
 * `import('../tools/definitions/computerTools').then(({ closeAxSession }) =>
 * closeAxSession().catch(() => {})).catch(() => {})` — double-wrapped, both
 * the outer import AND the inner call already tolerate failure). This is a
 * SEPARATE reachability path from `builtins.ts` — which itself is redirected
 * wholesale to `builtinsRun.ts` (§ builtins) and therefore never actually
 * imports the REAL `computerTools.ts` at all — `builtinsRun.ts`'s own
 * `setComputerUseBatchMode`/`setSkipAutoScreenshot` are independent
 * `cu.setState`-forwarding reimplementations that don't touch this file.
 *
 * THROWING bundle-graph-only shim for `closeAxSession`. Reasoning: macOS
 * Accessibility (AX) sessions are opened/managed via native Tauri commands
 * (Rust/Swift), reached through `invoke()` — which itself reverses via
 * `tauriCoreInvokeRun.ts`'s `native.invoke` forwarding. The sidecar process
 * has no native AX bridge of its own; whatever AX session state exists lives
 * SHELL-side, reachable only through the shell's own native command
 * handlers — a sidecar-local `closeAxSession()` was never going to be able
 * to close a shell-side-only resource regardless of how this module is
 * shimmed. Both call-site layers already swallow failures
 * (`closeAxSession().catch(() => {})` AND the outer
 * `import(...).catch(() => {})`), so throwing here is a safe no-op from the
 * loop's perspective — not a new failure mode.
 *
 * The two parameters mirror the real `closeAxSession(conversationId?,
 * loopId?)` and are deliberately ignored — this shim always throws, so it has
 * nothing to scope. They exist so `shimSurfaceTypes.ts` can prove the arity
 * matches rather than having to allowlist this export.
 */
import type { ShimThrowKind } from './shimThrowKind';

/**
 * `closeAxSession()` 直接抛出错误。AX 会话由 shell 一侧的原生命令创建和持有，sidecar
 * 进程里没有这份状态，在这里无法关闭它。关闭由 shell 完成：`agentLoopRunner.ts` 在
 * 一次 sidecar 运行结束时调用真实的 `closeAxSession()`。`agentLoop.ts` 的四个调用处
 * 对加载模块和调用本身各有一层 `.catch(() => {})`，这里抛出错误不影响主循环。
 */
export const SHIM_THROW_KIND: ShimThrowKind = 'shell-side';

export async function closeAxSession(_conversationId?: string, _loopId?: string): Promise<void> {
  throw new Error(
    '[sidecar] tools/definitions/computerTools.ts\'s closeAxSession() reached inside the sidecar bundle — AX session state is shell-side-only (native Tauri commands), unreachable from the sidecar process regardless of shimming. Both call-site layers in agentLoop.ts already swallow this via .catch(() => {}), so this is a safe no-op, not a crash.',
  );
}
