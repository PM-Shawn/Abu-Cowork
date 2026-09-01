import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from '@/utils/tauriEnv';

/**
 * Destroy the native webviews behind the given workspace browser tab ids.
 *
 * A browser tab's native view (an Electron `WebContentsView` painted over the
 * React UI) is owned by the TAB RECORD in `previewStore`, not by the
 * `<BrowserTab>` component that renders it. The panel legitimately unmounts
 * around a live view — collapsed panel, non-chat view mode — and an agent's
 * page, login state and half-filled form must survive that, so unmounting only
 * hides the view. Destroying it happens exactly where the tab record is
 * removed (`closeTab` / `closeOtherTabs` / `closeAllTabs`), which is the one
 * place that means "the user closed this tab".
 *
 * Best-effort and non-blocking: `browser_close` is idempotent in the host and a
 * tab whose view was never created (empty "start" tab) is a no-op there.
 */
export function closeBrowserViews(tabIds: readonly string[]): void {
  if (tabIds.length === 0 || !isTauriEnv()) return;
  for (const id of tabIds) {
    // `Promise.resolve` so a host stub that returns a non-promise can't throw
    // inside a store action.
    void Promise.resolve(invoke('browser_close', { id })).catch(() => {});
  }
}
