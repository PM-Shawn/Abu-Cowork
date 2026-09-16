/**
 * Flat, wire-safe projection of the i18n keys `subagentLoop.ts` reads via
 * `getI18n()`. Zero imports — bundle-safe on BOTH sides of the process
 * boundary (shell webview AND sidecar bundle), per
 * docs/2026-07-19-phase1-p3-loop-migration-staging.md §2 "正式步 3a" item 8
 * ("i18n → getI18n backed by the pushed locale + `uiStrings` bag").
 *
 * Shell side (subagentRunner.ts): calls `buildSubagentUiStrings(getI18n())`
 * at `subagent.run` dispatch time and sends the flat bag as part of the
 * wire params.
 *
 * Sidecar side (sidecar/src/shims/i18nRun.ts): reconstructs a `getI18n()`-
 * shaped object from the per-run bag, throwing a clear error on any key
 * NOT in `SUBAGENT_UI_STRING_KEYS` — this is what "catches drift in tests":
 * if `subagentLoop.ts` is later edited to reference a NEW i18n key, this
 * list (and `buildSubagentUiStrings` below) must be updated too, or the
 * sidecar path throws immediately instead of silently returning `undefined`
 * or a raw key string.
 */

/** Every i18n key `subagentLoop.ts` reads, as dotted paths — keep in sync by grepping `getI18n()` there. */
export const SUBAGENT_UI_STRING_KEYS = [
  'chat.subagent.taskCancelled',
  'chat.subagent.outputLimitIncomplete',
  'chat.subagent.stoppedIncomplete',
  'chat.subagent.cancelled',
  'chat.subagent.hookBlocked',
  'chat.subagent.noContent',
  'chat.subagent.delegatedVisionUnsupported',
  'chat.subagent.delegatedDocumentUnsupported',
  'chat.subagent.delegatedMediaLimitExceeded',
  'chat.subagent.delegatedMediaInvalid',
  'chat.errorEmptyBody',
] as const;

export type SubagentUiStringKey = (typeof SUBAGENT_UI_STRING_KEYS)[number];

/** Flat bag — wire-safe (plain string values, JSON-serializable). */
export type SubagentUiStrings = Record<SubagentUiStringKey, string>;

/**
 * Minimal structural shape this module needs from `TranslationDict` — kept
 * local (not imported from `src/i18n/types.ts`) so this file stays
 * dependency-free. `getI18n()`'s real return value satisfies this shape.
 */
interface I18nSourceShape {
  chat: {
    subagent: {
      taskCancelled: string;
      outputLimitIncomplete: string;
      stoppedIncomplete: string;
      cancelled: string;
      hookBlocked: string;
      noContent: string;
      delegatedVisionUnsupported: string;
      delegatedDocumentUnsupported: string;
      delegatedMediaLimitExceeded: string;
      delegatedMediaInvalid: string;
    };
    errorEmptyBody: string;
  };
}

/** Build the flat wire bag from a live `TranslationDict` (shell-side, called at dispatch time — see subagentRunner.ts). */
export function buildSubagentUiStrings(t: I18nSourceShape): SubagentUiStrings {
  return {
    'chat.subagent.taskCancelled': t.chat.subagent.taskCancelled,
    'chat.subagent.outputLimitIncomplete': t.chat.subagent.outputLimitIncomplete,
    'chat.subagent.stoppedIncomplete': t.chat.subagent.stoppedIncomplete,
    'chat.subagent.cancelled': t.chat.subagent.cancelled,
    'chat.subagent.hookBlocked': t.chat.subagent.hookBlocked,
    'chat.subagent.noContent': t.chat.subagent.noContent,
    'chat.subagent.delegatedVisionUnsupported': t.chat.subagent.delegatedVisionUnsupported,
    'chat.subagent.delegatedDocumentUnsupported': t.chat.subagent.delegatedDocumentUnsupported,
    'chat.subagent.delegatedMediaLimitExceeded': t.chat.subagent.delegatedMediaLimitExceeded,
    'chat.subagent.delegatedMediaInvalid': t.chat.subagent.delegatedMediaInvalid,
    'chat.errorEmptyBody': t.chat.errorEmptyBody,
  };
}
