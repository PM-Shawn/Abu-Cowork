import type { LoopContext } from './permissionBridge';
import type { SubagentProgressEvent } from './subagentLoop';
import type { BatchTaskRef } from '../../types/execution';

/** Poll interval, and attempt budget, for draining member progress whose
 *  parent step is not visible yet (~500 ms in total). */
export const DELEGATE_DRAIN_POLL_MS = 5;
export const DELEGATE_DRAIN_MAX_ATTEMPTS = 100;

export interface DelegateProgressRecorder {
  /** Record a member tool-start / tool-end as a child of the dispatch step. */
  record: (event: SubagentProgressEvent) => void;
  /** Bounded wait for queued events' parent step, then {@link settle}. */
  drain: () => Promise<void>;
  /** Stop polling, drop whatever is still queued, run `onSettle`. */
  settle: () => void;
}

/**
 * Records a delegated member's tool calls as child steps of the
 * delegate_to_agent / run_agent_batch step that dispatched it.
 *
 * When the leader loop runs in the sidecar, the shell applies that step's
 * addStep frame in order behind awaited ledger writes, while member progress
 * arrives on its own `subagent.progress` channel. A member can therefore
 * report — or even finish — before its parent step is visible (2026-09-07
 * delegate retest G1; 2026-09-16 batch E2E). Events are queued until the
 * parent resolves instead of being dropped, and the dispatch tool awaits
 * {@link DelegateProgressRecorder.drain} before returning, so the frames that
 * follow its result (step result, turn-end snapshot) see the recorded children.
 */
export function createDelegateProgressRecorder(options: {
  loopCtx: Pick<LoopContext, 'loopId' | 'eventRouter'>;
  resolveParentStepId: () => string | undefined;
  /** Tag for run_agent_batch children: which member produced them. */
  batchTask?: BatchTaskRef;
  /** A child step was added or completed. */
  onChildStepChange?: () => void;
  /** Runs once the recorder is settled (drained or abandoned). */
  onSettle?: () => void;
  /** Tool name for the dropped-events debug line. */
  logLabel: string;
}): DelegateProgressRecorder {
  const { loopCtx, resolveParentStepId, batchTask, onChildStepChange, onSettle, logLabel } = options;
  const childIdMap = new Map<string, string>(); // member tool_use id -> child step id
  const pending: SubagentProgressEvent[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryCount = 0;

  const apply = (event: SubagentProgressEvent, parentStepId: string): void => {
    if (event.type === 'tool-start') {
      const childStepId = loopCtx.eventRouter.addChildStepToDelegate(loopCtx.loopId, parentStepId, {
        toolName: event.toolName,
        toolInput: event.toolInput,
        toolCallId: event.id,
        ...(batchTask ? { batchTask } : {}),
      });
      if (childStepId) {
        childIdMap.set(event.id, childStepId);
        onChildStepChange?.();
      }
    } else if (event.type === 'tool-end') {
      const childStepId = childIdMap.get(event.id);
      childIdMap.delete(event.id);
      if (childStepId) {
        loopCtx.eventRouter.completeChildStep(
          loopCtx.loopId, parentStepId, childStepId, event.result, event.error, event.resultContent,
        );
        onChildStepChange?.();
      }
    }
  };

  const cancelRetry = (): void => {
    if (retryTimer === undefined) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const flushPending = (): void => {
    cancelRetry();
    const parentStepId = resolveParentStepId();
    if (!parentStepId) {
      if (pending.length > 0 && retryCount < DELEGATE_DRAIN_MAX_ATTEMPTS) {
        retryCount += 1;
        retryTimer = setTimeout(flushPending, DELEGATE_DRAIN_POLL_MS);
      }
      return;
    }
    for (const event of pending.splice(0)) apply(event, parentStepId);
    retryCount = 0;
  };

  const settle = (): void => {
    cancelRetry();
    if (pending.length > 0) {
      console.debug(`[${logLabel}] dropped ${pending.length} member progress event(s): the parent step never became visible`);
      pending.length = 0;
    }
    onSettle?.();
  };

  return {
    record: (event) => {
      if (event.type !== 'tool-start' && event.type !== 'tool-end') return;
      const parentStepId = resolveParentStepId();
      if (!parentStepId) {
        pending.push(event);
        if (retryTimer === undefined) {
          retryCount = 0;
          retryTimer = setTimeout(flushPending, 0);
        }
        return;
      }
      flushPending();
      apply(event, parentStepId);
    },
    drain: async () => {
      for (let attempt = 0; attempt < DELEGATE_DRAIN_MAX_ATTEMPTS && pending.length > 0; attempt += 1) {
        flushPending();
        if (pending.length === 0) break;
        await new Promise<void>((resolve) => setTimeout(resolve, DELEGATE_DRAIN_POLL_MS));
      }
      flushPending();
      settle();
    },
    settle,
  };
}
