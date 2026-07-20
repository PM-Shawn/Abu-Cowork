/**
 * Sidecar-local replacement for `src/core/llm/usageTracker.ts`.
 *
 * THROWING bundle-graph-only shim. The real module has exactly ONE export
 * (`recordTurnUsage`, verified by grep) and reaches `src/stores/usageStatsStore.ts`
 * (a persisted Zustand store — cost/usage dashboard data) directly.
 * Reachability: ONLY `agentLoop.ts`'s single dynamic-import call site
 * (`import('../llm/usageTracker').then(({ recordTurnUsage }) =>
 * recordTurnUsage(...)).catch(() => {})`), same safe-degradation shape as
 * `memdirExtractorRun.ts` — the sole call site already wraps this in
 * `.catch(() => {})`, so a thrown rejection here is swallowed, not a crash.
 *
 * Not covered by design doc §6's explicit exclusion list (unlike the
 * extractor), so flagged here as a genuine new finding: per-turn usage-stats
 * recording (the cost/token dashboard) silently does not happen for
 * sidecar-run main-loop turns this batch. A real, bounded feature gap — the
 * turn still completes correctly and the LLM call itself is unaffected;
 * only the persisted usage-stats aggregate misses this turn's contribution.
 * Building a real forwarding shim (a `usage.record` notification + shell
 * handler) is straightforward follow-up work, deliberately deferred here
 * given this batch's scope (see P1-3B-3A-REPORT.md's escalations).
 */
export function recordTurnUsage(
  ..._args: unknown[]
): void {
  throw new Error(
    '[sidecar] llm/usageTracker.ts reached inside the sidecar bundle — usage-stats recording has no forwarding shim yet this batch (genuine gap, not design-doc-excluded like memdir/extractor.ts). The sole call site already wraps this in .catch(() => {}), so this is a safe, documented feature gap, not a crash — see P1-3B-3A-REPORT.md escalations.',
  );
}
