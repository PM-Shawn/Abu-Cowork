/**
 * Sidecar-local replacement for `src/core/agent/entryOrchestration.ts`.
 *
 * THROWING bundle-graph-only shim (P1-3B-3A item 1's design). `agentLoop.ts`
 * reaches this module ONLY via a DYNAMIC `await import('./entryOrchestration')`
 * inside its `options?.orchestration ?? ...` fallback branch — provably dead
 * on the sidecar path, since `agentLoopHost.ts` ALWAYS supplies
 * `options.orchestration` (precomputed shell-side by 3b-3B's dispatcher,
 * using this SAME `precomputeOrchestration` function, which stays
 * shell-side / out of the sidecar bundle). esbuild still statically follows
 * dynamic `import()` calls for bundling purposes, and the REAL
 * `entryOrchestration.ts` imports from `./orchestrator` (the heaviest
 * DRAGGER cluster in the app) — so without this redirect, that whole graph
 * would get bundled anyway despite the branch being runtime-dead. Throws
 * loudly if ever actually reached (wiring-bug signal), same discipline as
 * `orchestratorRun.ts`.
 */
export function precomputeOrchestration(..._args: unknown[]): never {
  throw new Error(
    '[sidecar] entryOrchestration.ts\'s precomputeOrchestration() reached inside the sidecar bundle — agentLoopHost.ts should always inject a precomputed AgentLoopOptions.orchestration for every sidecar-run main loop. This indicates a wiring bug, not a legitimate "no orchestration available" case.',
  );
}
