/**
 * Sidecar-local replacement for `src/i18n/index.ts`.
 *
 * REAL behavior shim, upgraded from a 7-key "bag" (P1-3a, subagent-only) to
 * a FULL-DICT shim (P1-3B-3B). The real module's problem was never the
 * locale data itself — `src/i18n/locales/zh-CN.ts` and `en-US.ts` are pure
 * data (verified: `grep -n "^import" src/i18n/locales/{zh-CN,en-US}.ts`
 * shows only `import type { TranslationDict } from '../types'`, and
 * `src/i18n/types.ts` itself has ZERO imports — both dicts are safe to
 * import directly into the sidecar bundle). The problem was `getI18n()`'s
 * LOCALE RESOLUTION: the real module's `getResolvedLocale()` reads
 * `currentLanguageSetting` (in-memory webview state, set by
 * `settingsStore.ts`'s `setLanguage`) and `useI18n()` is backed by React's
 * `useSyncExternalStore` — neither is meaningful/importable in the sidecar.
 *
 * So this shim imports BOTH real dictionaries directly (byte-identical
 * translation strings — no re-hosting/duplication of content) and only
 * reimplements `getLocale()`'s resolution, `getI18n()`, and `format()`
 * (verbatim copy of the real module's placeholder-substitution logic — pure,
 * zero imports).
 *
 * `getLocale()` resolves via a DUAL fallback, because this module is loaded
 * by BOTH the subagent mini-loop path (`subagentLoop.ts`, wrapped in
 * `subagentRunContext.run()`, P1-3a) and the MAIN loop path (`agentLoop.ts`
 * and everything it calls, wrapped in `agentRunContext.run()`,
 * P1-3B-3A) — including a MAIN-loop-nested subagent run via
 * `shims/subagentRunnerRun.ts`, which runs `runSubagentLoop` INSIDE the
 * parent's `agentRunContext` scope with no separate `subagentRunContext.run()`
 * wrapper (see that shim's doc). Try `agentRunContext` first (the more
 * common case going forward — every sidecar-run main loop, plus any subagent
 * nested under one), fall back to `subagentRunContext` (top-level
 * `subagent.run` RPC, unchanged from P1-3a) — if BOTH throw (no active run
 * scope at all), that is a genuine wiring bug and this shim throws too,
 * rather than silently defaulting to a hardcoded locale (which would corrupt
 * output-language selection for whichever locale wasn't guessed).
 */
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';
import type { SupportedLocale, TranslationDict } from '@/i18n/types';
import { getCurrentAgentRunContext } from '../agentRunContext';
import { getCurrentSubagentRunContext } from '../subagentRunContext';

const locales: Record<SupportedLocale, TranslationDict> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

function isSupportedLocale(locale: string): locale is SupportedLocale {
  return locale === 'zh-CN' || locale === 'en-US';
}

/**
 * Resolve the current run's locale — main-loop context first, subagent
 * context as fallback, throw if neither is active. See module doc for why
 * both are tried (never silently defaults).
 */
export function getLocale(): SupportedLocale {
  let raw: string;
  try {
    raw = getCurrentAgentRunContext().locale;
  } catch {
    try {
      raw = getCurrentSubagentRunContext().locale;
    } catch {
      throw new Error(
        '[sidecar i18n shim] getLocale() called outside both agentRunContext and subagentRunContext scopes — no run context available. This indicates a wiring bug (a port shim was called from code not running inside agentLoopHost.ts\'s or subagentHost.ts\'s AsyncLocalStorage scope).',
      );
    }
  }
  // Defensive: a run context's locale field should always be one of the two
  // supported locales (both hosts source it from getLocale()/getSettingsReader()
  // shell-side) — but don't silently coerce an unexpected value to a
  // hardcoded default; throw so drift is caught, same "escalate cleanly"
  // discipline as the rest of this shim.
  if (!isSupportedLocale(raw)) {
    throw new Error(`[sidecar i18n shim] Unsupported locale "${raw}" in run context — expected "zh-CN" or "en-US".`);
  }
  return raw;
}

/** Mirrors `src/i18n/index.ts`'s `getI18n()` — the FULL real TranslationDict for the current run's resolved locale. */
export function getI18n(): TranslationDict {
  return locales[getLocale()];
}

/** Verbatim copy of `src/i18n/index.ts`'s `format()` — pure string substitution, no imports, safe to duplicate rather than import (avoids a runtime edge back into `src/i18n/index.ts`, which itself imports React). */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
}
