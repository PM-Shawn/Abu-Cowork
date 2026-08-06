/**
 * Per-run ambient context for concurrent subagent runs inside the sidecar.
 *
 * `subagentLoop.ts` calls a few things as bare module-level imports rather
 * than through an injected port (`getI18n()`, `resolveEffectiveLlmCreds()`)
 * — see docs/2026-07-19-phase1-p3-loop-migration-staging.md §2 "正式步 3a"
 * item 8. Those two get sidecar-local shim replacements
 * (`shims/i18nRun.ts`, `shims/enterpriseCredsRun.ts`) that need to know
 * "which run is this call happening on behalf of" WITHOUT subagentLoop.ts
 * itself threading a runId through every call site (that would be a
 * behavior-shape change to a file we're keeping otherwise untouched this
 * phase).
 *
 * `node:async_hooks`' `AsyncLocalStorage` solves exactly this: it carries a
 * value through an async call chain automatically, correctly scoped even
 * when multiple subagent runs interleave concurrently (P1-3a's "subagent
 * 并发多实例" requirement — runId routing must stay correct per-run even
 * though tool.invoke/hook.emit calls from different runs can interleave on
 * the same event loop). `subagentHost.ts` wraps each run's
 * `runSubagentLoop(options)` call in `subagentRunContext.run(ctx, () => ...)`;
 * every async function called transitively from inside that callback sees
 * the same `ctx` via `getCurrentSubagentRunContext()`, even across `await`
 * boundaries and Promise.all fan-out — while a DIFFERENT concurrent run's
 * calls see ITS OWN context, never this one's.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SubagentUiStrings } from '@/core/agent/subagentUiStrings';

export interface SubagentRunContext {
  runId: string;
  locale: string;
  uiStrings: SubagentUiStrings;
  /**
   * Pre-resolved shell-side at `subagent.run` dispatch time — see
   * subagentRunner.ts's `buildSubagentRunParams()`. Frozen for the whole
   * run (see `shims/enterpriseCredsRun.ts`'s doc for why re-deriving
   * per-call, as the real `resolveEffectiveLlmCreds` does in-process, isn't
   * done here).
   */
  resolvedCreds: { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean; traceMetadata?: Record<string, string | undefined> };
}

export const subagentRunContext = new AsyncLocalStorage<SubagentRunContext>();

/**
 * Read the current run's context. Throws when called outside an active
 * `subagentRunContext.run(...)` scope — this always indicates a bug in
 * `subagentHost.ts`'s wiring (every subagent-loop code path that reaches
 * one of the shims below is, by construction, inside that scope), not a
 * legitimate "no context available" case to silently tolerate.
 */
export function getCurrentSubagentRunContext(): SubagentRunContext {
  const store = subagentRunContext.getStore();
  if (!store) {
    throw new Error(
      '[sidecar] subagent run context accessed outside subagentHost.ts\'s AsyncLocalStorage scope — this indicates a wiring bug (a shim was called from code not running inside subagentRunContext.run()).',
    );
  }
  return store;
}
