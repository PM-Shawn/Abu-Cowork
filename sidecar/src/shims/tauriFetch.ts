/**
 * Sidecar shim for `src/core/llm/tauriFetch.ts`.
 *
 * The real module routes through `@tauri-apps/plugin-http` IPC to bypass
 * WebView CORS — meaningless in a plain Node process, which has no WebView
 * and no CORS restrictions to begin with. The real module ALREADY falls
 * back to `globalThis.fetch` when `window`/`__TAURI_INTERNALS__` are absent
 * (see its own doc comment), which is always true under Node — so this shim
 * is for determinism/clarity and to avoid bundling the plugin-http dynamic
 * import path at all, not to change behavior. Swapped in at bundle time by
 * `scripts/build-sidecar.mjs`. Same public surface (`getTauriFetch()`).
 */

export function getTauriFetch(): Promise<typeof globalThis.fetch> {
  return Promise.resolve(globalThis.fetch);
}
