/**
 * Sidecar-local replacement for `src/core/enterprise/llm-resolver.ts`'s
 * `resolveEffectiveLlmCreds`. The real function reads
 * `useEnterpriseStore.getState()` (a Zustand webview store) on every call —
 * not importable in the sidecar bundle.
 *
 * Per docs/2026-07-19-phase1-p3-loop-migration-staging.md §2 "正式步 3a"
 * item 6/8: creds are PRE-RESOLVED shell-side at `subagent.run` dispatch
 * time (`subagentRunner.ts`'s `buildSubagentRunParams()`) and pushed as
 * `resolvedCreds`. This shim just returns that frozen value from the
 * current run's `AsyncLocalStorage` context.
 *
 * ⚠️ KNOWN, DOCUMENTED BEHAVIOR DIFFERENCE from the in-process path:
 * `subagentLoop.ts` calls the real `resolveEffectiveLlmCreds` MULTIPLE
 * times per run (once for adapter-kind selection, again per turn for
 * context compression, again per turn for chat creds) — in-process, each
 * call re-reads the LIVE enterprise store. This shim instead returns the
 * SAME value every time — resolved once, shell-side, before the sidecar
 * run even starts. A subagent run is short-lived (seconds to a few
 * minutes) and an enterprise gateway virtual key does not rotate mid-run
 * in practice, so freezing for the run's duration is a deliberate
 * simplification, not an oversight — see P1-3a-REPORT.md's projection
 * table. `personalApiKey`/`personalBaseUrl` are accepted (to match the
 * real function's signature — subagentLoop.ts's call sites are unchanged)
 * but IGNORED: the frozen value already has the right answer baked in.
 */
import { getCurrentSubagentRunContext } from '../subagentRunContext';

export function resolveEffectiveLlmCreds(
  _personalApiKey: string,
  _personalBaseUrl: string | undefined,
): { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean } {
  return getCurrentSubagentRunContext().resolvedCreds;
}
