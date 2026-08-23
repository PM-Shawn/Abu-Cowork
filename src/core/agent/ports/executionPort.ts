import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import type { TaskExecution, ExecutionStep, DetailBlock } from '@/types/execution';
import type { TokenUsage } from '@/types';
import { createPortSlot } from './portSlot';

/**
 * Port abstracting agentLoop's directly-invoked execution calls on
 * taskExecutionStore — both the *lifecycle* calls (creating a TaskExecution
 * at loop start, cancelling it at each early-exit point, and — from the
 * standalone module-level `persistExecutionSnapshot` function — looking one
 * up by loopId and evicting it from memory once its steps have been
 * persisted onto the conversation) AND, as of P1-3b-pre, the *step-mutation*
 * family `eventRouter.ts` calls on the `executionStore` it's constructed
 * with.
 *
 * Scope note (see C-REPORT.md for the full agentLoop store-coupling
 * inventory, and P1-3b-pre-REPORT.md for why the step-mutation family was
 * folded in here rather than left as a raw store capture):
 *  - the step-level *snapshot* writes (`setExecutionStepsSnapshot` /
 *    `setPlannedStepsSnapshot`) already go through `ChatDelta` (see
 *    chatDelta.ts's "Discrete family") — those are a different concern
 *    (persisting a finished execution's steps onto a chat message), not
 *    the live per-event step mutations below.
 *  - the `executionStore` reference threaded into `createEventRouter`'s
 *    `deps` in agentLoop.ts used to be a raw `useTaskExecutionStore.getState()`
 *    capture, deliberately left alone by the C batch ("那是 D 块的事" — see
 *    C-REPORT.md §"Deliberately NOT touched"). P1-3b-pre is that later batch:
 *    `EventRouterDeps.executionStore` is now typed as this same `ExecutionPort`
 *    (see eventRouter.ts), and agentLoop.ts passes its `executionPort` local
 *    straight through — no more separate `taskExecutionStore` local, no more
 *    dual-use split.
 *  - `eventRouter.ts` does NOT need every `TaskExecutionStore` method — only
 *    the 13 it actually calls (verified by grep, not assumed:
 *    `createExecution`/`getExecutionByLoopId` already existed here;
 *    `appendThinking`/`setThinkingDuration`/`addStep`/`setStepResult`/
 *    `setStepError`/`addDetailBlock`/`setUsage`/`completeExecution`/
 *    `errorExecution`/`addChildStep`/`updateChildStep` are the 11 new ones
 *    below). `updateStepStatus`/`updateStepProgress`/`toggleDetailExpanded`/
 *    `updateDetailBlockContent`/`setThinking`/`setPlannedSteps`/
 *    `markPlanParsed`/the query family beyond `getExecutionByLoopId`/
 *    `clearConversation`/`clearAll` are NOT used by either agentLoop.ts or
 *    eventRouter.ts and are deliberately NOT added — this port stays a
 *    precise mirror of consumed surface, not the full store shape.
 *
 * Same call-time-not-cached discipline as the other ports in this
 * directory: every method re-fetches `useTaskExecutionStore.getState()` at
 * call time, never memoized.
 */
export interface ExecutionPort {
  /** Mirrors taskExecutionStore's `createExecution`. */
  createExecution(conversationId: string, loopId: string): TaskExecution;
  /** Mirrors taskExecutionStore's `cancelExecution`. */
  cancelExecution(execId: string): void;
  /** Mirrors taskExecutionStore's `getExecutionByLoopId`. */
  getExecutionByLoopId(loopId: string): TaskExecution | undefined;
  /** Mirrors taskExecutionStore's `getExecutionByConversationId` (added
   *  P1-3b-1 — plannedStepsPrompt.ts's DI seam, see that module). */
  getExecutionByConversationId(conversationId: string): TaskExecution | undefined;
  /** Mirrors taskExecutionStore's `evictExecution`. */
  evictExecution(execId: string): void;

  // ── Step-mutation family (added P1-3b-pre — eventRouter.ts's DI seam) ──
  /** Mirrors taskExecutionStore's `completeExecution`. */
  completeExecution(execId: string): void;
  /** Mirrors taskExecutionStore's `errorExecution`. */
  errorExecution(execId: string, error: string): void;
  /** Mirrors taskExecutionStore's `addStep`. */
  addStep(execId: string, step: ExecutionStep): void;
  /** Mirrors taskExecutionStore's `setStepResult`. */
  setStepResult(execId: string, stepId: string, result: string): void;
  /** Mirrors taskExecutionStore's `setStepError`. */
  setStepError(execId: string, stepId: string, error: string): void;
  /** Mirrors taskExecutionStore's `addChildStep`. */
  addChildStep(execId: string, parentStepId: string, childStep: ExecutionStep): void;
  /** Mirrors taskExecutionStore's `updateChildStep`. */
  updateChildStep(execId: string, parentStepId: string, childStepId: string, result: string, error?: boolean, detailBlocks?: DetailBlock[]): void;
  /** Mirrors taskExecutionStore's `addDetailBlock`. */
  addDetailBlock(execId: string, stepId: string, block: DetailBlock): void;
  /** Mirrors taskExecutionStore's `appendThinking`. */
  appendThinking(execId: string, content: string): void;
  /** Mirrors taskExecutionStore's `setThinkingDuration`. */
  setThinkingDuration(execId: string, duration: number): void;
  /** Mirrors taskExecutionStore's `setUsage`. */
  setUsage(execId: string, usage: TokenUsage): void;
}

/** Default in-process implementation over the Zustand store's synchronous
 *  getState(). This is the seam a future out-of-process agent runtime
 *  (headless Node sidecar) would replace with an IPC/RPC-backed
 *  implementation. */
export function createInProcessExecutionPort(): ExecutionPort {
  return {
    createExecution: (conversationId, loopId) =>
      useTaskExecutionStore.getState().createExecution(conversationId, loopId),
    cancelExecution: (execId) => useTaskExecutionStore.getState().cancelExecution(execId),
    getExecutionByLoopId: (loopId) => useTaskExecutionStore.getState().getExecutionByLoopId(loopId),
    getExecutionByConversationId: (conversationId) => useTaskExecutionStore.getState().getExecutionByConversationId(conversationId),
    evictExecution: (execId) => useTaskExecutionStore.getState().evictExecution(execId),

    completeExecution: (execId) => useTaskExecutionStore.getState().completeExecution(execId),
    errorExecution: (execId, error) => useTaskExecutionStore.getState().errorExecution(execId, error),
    addStep: (execId, step) => useTaskExecutionStore.getState().addStep(execId, step),
    setStepResult: (execId, stepId, result) => useTaskExecutionStore.getState().setStepResult(execId, stepId, result),
    setStepError: (execId, stepId, error) => useTaskExecutionStore.getState().setStepError(execId, stepId, error),
    addChildStep: (execId, parentStepId, childStep) =>
      useTaskExecutionStore.getState().addChildStep(execId, parentStepId, childStep),
    updateChildStep: (execId, parentStepId, childStepId, result, error, detailBlocks) =>
      useTaskExecutionStore.getState().updateChildStep(execId, parentStepId, childStepId, result, error, detailBlocks),
    addDetailBlock: (execId, stepId, block) => useTaskExecutionStore.getState().addDetailBlock(execId, stepId, block),
    appendThinking: (execId, content) => useTaskExecutionStore.getState().appendThinking(execId, content),
    setThinkingDuration: (execId, duration) => useTaskExecutionStore.getState().setThinkingDuration(execId, duration),
    setUsage: (execId, usage) => useTaskExecutionStore.getState().setUsage(execId, usage),
  };
}

/** Module-level slot for the app-wide default ExecutionPort — see
 *  `portSlot.ts` for the shared get/set/swap-hook contract every port in
 *  this directory follows. All core/ callers that don't receive an
 *  explicit port via options should go through `getExecutionPort()`
 *  instead of constructing their own in-process port, so there's a single
 *  seam to flip when the headless Node runtime starts up (see
 *  `setExecutionPort`). */
const slot = createPortSlot<ExecutionPort>(createInProcessExecutionPort);

export function getExecutionPort(): ExecutionPort {
  return slot.get();
}

export function setExecutionPort(port: ExecutionPort): void {
  slot.set(port);
}

/**
 * Narrow id-preserving apply seam for P1-3b-2's shell-side frame applier
 * (`src/core/agent/frameApplier.ts`) — applies a `createExecution` frame
 * built by a sidecar-run agent loop's local execution mirror
 * (`sidecar/src/portFrameSenders.ts`), which derives the execution's id
 * from `loopId` (both sides use `id === loopId` by convention — see
 * `taskExecutionStore.ts`'s `createExecutionWithId` doc comment). Bypasses
 * `getExecutionPort()` deliberately — this always targets the REAL
 * in-process store. Not part of the `ExecutionPort` interface
 * (id-preserving writes aren't a loop-facing concern). */
export function applyExecutionWithId(conversationId: string, loopId: string, id: string): TaskExecution {
  return useTaskExecutionStore.getState().createExecutionWithId(conversationId, loopId, id);
}
