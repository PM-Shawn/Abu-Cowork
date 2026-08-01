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
 */
export async function closeAxSession(): Promise<void> {
  throw new Error(
    '[sidecar] tools/definitions/computerTools.ts\'s closeAxSession() reached inside the sidecar bundle — AX session state is shell-side-only (native Tauri commands), unreachable from the sidecar process regardless of shimming. Both call-site layers in agentLoop.ts already swallow this via .catch(() => {}), so this is a safe no-op, not a crash.',
  );
}
