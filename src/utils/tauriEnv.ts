/**
 * Returns true iff the app is running inside the Tauri webview (desktop build).
 *
 * Tauri always injects `window.__TAURI_INTERNALS__` into the webview before any
 * JS runs.  In plain browser / E2E / SSR contexts this property is absent, so
 * attempting to call Tauri plugin APIs (getCurrentWindow, listen, invoke …)
 * would throw a synchronous TypeError.  Guard every Tauri-only code path with
 * this check to keep the app functional in web / test mode.
 */
export function isTauriEnv(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}
