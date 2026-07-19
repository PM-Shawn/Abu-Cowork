/**
 * Sidecar-local replacement for `src/i18n/index.ts`'s `getI18n()`.
 *
 * The real module imports React's `useSyncExternalStore` and keeps its
 * "current locale" as in-memory webview state — neither exists/is
 * meaningful in the sidecar process. `subagentLoop.ts` only ever calls the
 * bare `getI18n()` function (never `useI18n`/`getLocale`), and only reads 7
 * specific leaf keys (see `src/core/agent/subagentUiStrings.ts`'s
 * `SUBAGENT_UI_STRING_KEYS`) — so this shim reconstructs JUST that shape
 * from the per-run `uiStrings` bag the shell pre-resolved and pushed via
 * `subagent.run` params (subagentRunner.ts's `buildSubagentUiStrings()`).
 *
 * Per docs/2026-07-19-phase1-p3-loop-migration-staging.md §2 "正式步 3a"
 * item 8: "sidecar shim throws-with-clear-message on a MISSING key rather
 * than silently returning the key string, so drift is caught in tests" — a
 * NEW key referenced by a future edit to `subagentLoop.ts` that isn't in
 * `SUBAGENT_UI_STRING_KEYS`/`buildSubagentUiStrings()` throws loudly here
 * instead of silently resolving to `undefined`.
 */
import { getCurrentSubagentRunContext } from '../subagentRunContext';

function readKey(fullKey: string): string {
  const { uiStrings } = getCurrentSubagentRunContext();
  const v = (uiStrings as Record<string, string>)[fullKey];
  if (v === undefined) {
    throw new Error(
      `[sidecar i18n shim] Missing uiStrings key "${fullKey}" — subagentLoop.ts references an i18n key that isn't pre-resolved into the shell-pushed bag. Add it to src/core/agent/subagentUiStrings.ts's SUBAGENT_UI_STRING_KEYS + buildSubagentUiStrings().`,
    );
  }
  return v;
}

/** Mirrors `src/i18n/index.ts`'s `getI18n()` return shape, but ONLY the leaves `subagentLoop.ts` actually reads. */
export function getI18n(): {
  chat: {
    subagent: {
      taskCancelled: string;
      outputLimitIncomplete: string;
      stoppedIncomplete: string;
      cancelled: string;
      hookBlocked: string;
      noContent: string;
    };
    errorEmptyBody: string;
  };
} {
  // Touch the context now so a call outside a run scope throws immediately
  // with subagentRunContext.ts's clear error, rather than lazily inside a
  // getter accessed later.
  getCurrentSubagentRunContext();
  return {
    chat: {
      subagent: {
        get taskCancelled() { return readKey('chat.subagent.taskCancelled'); },
        get outputLimitIncomplete() { return readKey('chat.subagent.outputLimitIncomplete'); },
        get stoppedIncomplete() { return readKey('chat.subagent.stoppedIncomplete'); },
        get cancelled() { return readKey('chat.subagent.cancelled'); },
        get hookBlocked() { return readKey('chat.subagent.hookBlocked'); },
        get noContent() { return readKey('chat.subagent.noContent'); },
      },
      get errorEmptyBody() { return readKey('chat.errorEmptyBody'); },
    },
  };
}
