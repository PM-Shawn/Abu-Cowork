import type { LoopContext } from './permissionBridge';
import { getExecutionPort } from './ports/executionPort';

/**
 * Resolve the execution step that owns a delegate_to_agent / run_agent_batch
 * call, so member tool calls can be recorded as its children.
 *
 * Lazy on purpose (retest G1, 2026-09-07): when the leader loop runs in the
 * sidecar, the dispatch tool executes over the reverse channel and can be
 * entered before the step-start frame for its own call has been applied to
 * the shell execution mirror. Resolving eagerly at tool entry then finds no
 * step and the whole member process is lost (nothing persisted, member tab
 * empty). Resolving at the first progress event — by the tool call id — sees
 * the step once the frame has landed. Cached after the first hit.
 */
export function createParentStepResolver(
  loopCtx: Pick<LoopContext, 'loopId' | 'toolCallToStepId' | 'eventRouter'>,
  toolCallId: string | undefined,
): () => string | undefined {
  let cached: string | undefined;
  return () => {
    if (cached) return cached;
    if (toolCallId) {
      cached = loopCtx.toolCallToStepId.get(toolCallId)
        ?? getExecutionPort().getExecutionByLoopId(loopCtx.loopId)?.steps.find((step) => step.toolCallId === toolCallId)?.id;
      // A known call id must never attach to a sibling whose frame arrived first.
      return cached;
    }
    const running = typeof loopCtx.eventRouter?.getCurrentStepId === 'function'
      ? loopCtx.eventRouter.getCurrentStepId(loopCtx.loopId)
      : null;
    if (running) {
      cached = running;
      return cached;
    }
    // Legacy in-process heuristic: the most recently mapped step.
    let last: string | undefined;
    for (const [, stepId] of loopCtx.toolCallToStepId) last = stepId;
    cached = last;
    return cached;
  };
}
