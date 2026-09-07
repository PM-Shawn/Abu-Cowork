import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from '@/utils/tauriEnv';

/**
 * Why a browser view is being destroyed.
 *
 * `user_close` means a HUMAN closed the tab (the tab strip's ×, close others,
 * close all) — the host reads that as "stop using the browser" and refuses to
 * open another tab for that owner until the user speaks again (N7). Everything
 * else is `lifecycle`: the app tidying up after itself (a withdrawn adoption, a
 * conversation delete), which must never be mistaken for a gesture.
 *
 * The distinction can only be made at the ACTION that removes the record — by
 * the time the ids reach the host they all look identical — so it is threaded
 * from `previewStore`'s user-facing close actions and defaults to `lifecycle`
 * for every other path.
 */
export type BrowserCloseReason = 'user_close' | 'lifecycle';

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
export function closeBrowserViews(
  tabIds: readonly string[],
  reason: BrowserCloseReason = 'lifecycle',
): void {
  if (tabIds.length === 0 || !isTauriEnv()) return;
  for (const id of tabIds) {
    // `Promise.resolve` so a host stub that returns a non-promise can't throw
    // inside a store action.
    void Promise.resolve(invoke('browser_close', { id, reason })).catch(() => {});
  }
}

/**
 * Tear down every browser view the host still holds for `conversationId`.
 *
 * Removing the tab records (above) already destroys the views this renderer
 * knows about; this is the belt-and-braces half for main-side state no tab
 * record covers — a headless fallback view nothing ever adopted, or an
 * adoption still in flight when the conversation was deleted. Ordering against
 * the per-tab `browser_close` calls does not matter: both are idempotent in the
 * host, and whichever lands second finds nothing left to close.
 *
 * Fire-and-forget like its sibling: a delete cascade must never be blocked (or
 * failed) by browser cleanup.
 */
export function disposeOwnedBrowserViews(conversationId: string): void {
  if (!conversationId || !isTauriEnv()) return;
  void Promise.resolve(invoke('browser_dispose_owner', { conversationId })).catch(() => {});
}

/**
 * Tear down the browser views ONE subagent run owns, leaving the conversation's
 * own loop and every sibling run untouched (N6/A2).
 *
 * A subagent's tabs are owned by the pair `{conversationId, runKey}` and are
 * invisible to every other run, so when the run ends nothing else can ever list
 * or close them: without this they would sit in main until the whole
 * conversation is deleted — one live `WebContentsView` per finished delegation,
 * for the rest of the session. Called at the run's settlement seal, the point
 * after which the run can no longer start another tool.
 *
 * Fire-and-forget and best-effort, like its siblings: a run must never fail, or
 * be held open by, its own resource cleanup.
 */
export function disposeRunBrowserViews(conversationId?: string, runKey?: string): void {
  if (!conversationId || !runKey || !isTauriEnv()) return;
  void Promise.resolve(
    invoke('browser_dispose_owner', { conversationId, runKey })
  ).catch(() => {});
}

/**
 * Lift the reclaim window a `user_close` opened for `conversationId` (N7).
 *
 * The user closing an agent's tab tells the host to stop opening new ones; the
 * user then WRITING to that conversation is them re-engaging with the task, and
 * is the signal that lifts it. Scope is the whole conversation — every subagent
 * run — because the user is addressing the task, not one of its delegations, and
 * has no way to know which run owned the tab they closed.
 *
 * Fire-and-forget: sending a message must never be blocked, delayed or failed by
 * browser bookkeeping. A lost call costs the run one more "ask the user first",
 * which the next message clears.
 */
export function clearBrowserReclaim(conversationId: string): void {
  if (!conversationId || !isTauriEnv()) return;
  void Promise.resolve(invoke('browser_clear_reclaim', { conversationId })).catch(() => {});
}
