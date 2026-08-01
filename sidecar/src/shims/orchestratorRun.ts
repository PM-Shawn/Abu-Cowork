/**
 * Sidecar-local replacement for `src/core/agent/orchestrator.ts`.
 *
 * THROWING bundle-graph-only shim (design doc §2 "雷 1" decision): orchestrator.ts
 * drags the heaviest DRAGGER cluster in the app (registry/mcpManager/
 * settingsStore/defaultWorkspace stores/skill loader) and only ever runs
 * ONCE, at loop entry, shell-side (3b-3B's dispatcher precomputes `route` +
 * `systemPromptSections` via `entryOrchestration.ts`'s
 * `precomputeOrchestration` and injects them as `AgentLoopOptions.orchestration`
 * — `agentLoopHost.ts` ALWAYS supplies it). `agentLoop.ts` itself only ever
 * reaches this module via a DYNAMIC `import('./entryOrchestration')` inside
 * its `options?.orchestration ?? ...` fallback branch — provably dead on the
 * sidecar path. Throws loudly if ever actually reached (wiring-bug signal),
 * same "escalate cleanly, don't silently degrade" discipline as the other
 * bundle-graph-only shims in this directory (`settingsReaderRun.ts` et al.).
 *
 * Exports only what's actually referenced anywhere in the sidecar's bundle
 * graph via a real (non-type-only) import — `routeInput`/
 * `buildSystemPromptSections`, both only reachable through
 * `entryOrchestration.ts` (also shimmed — see `entryOrchestrationRun.ts` —
 * so in practice NEITHER of these is ever loaded at runtime; this file
 * exists purely so a hypothetical direct import of `orchestrator.ts` from
 * anywhere else in the bundle graph fails loudly instead of silently
 * dragging the real module in).
 */
function throwWiringBug(name: string): never {
  throw new Error(
    `[sidecar] orchestrator.ts's ${name}() reached inside the sidecar bundle — agentLoopHost.ts should always inject a precomputed AgentLoopOptions.orchestration for every sidecar-run main loop. This indicates a wiring bug, not a legitimate "orchestrator not available" case.`,
  );
}

export function routeInput(_input: string): never {
  return throwWiringBug('routeInput');
}

export function buildSystemPromptSections(..._args: unknown[]): never {
  return throwWiringBug('buildSystemPromptSections');
}
