import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import type { TaskExecution } from '@/types/execution';

/**
 * Port abstracting agentLoop's directly-invoked execution *lifecycle* calls
 * on taskExecutionStore: creating a TaskExecution at loop start, cancelling
 * it at each early-exit point, and — from the standalone module-level
 * `persistExecutionSnapshot` function — looking one up by loopId and
 * evicting it from memory once its steps have been persisted onto the
 * conversation.
 *
 * Scope note (see C-REPORT.md for the full agentLoop store-coupling
 * inventory): this port does NOT cover —
 *  - the step-level snapshot writes (`setExecutionStepsSnapshot` /
 *    `setPlannedStepsSnapshot`) — those already went through `ChatDelta` in
 *    an earlier batch (see chatDelta.ts's "Discrete family").
 *  - the `executionStore` reference threaded into `createEventRouter`'s
 *    `deps` in agentLoop.ts — that's a distinct dependency-injection seam
 *    for event-routing step mutations (addStep/updateStepStatus/etc.),
 *    intentionally left alone for a later batch.
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
  /** Mirrors taskExecutionStore's `evictExecution`. */
  evictExecution(execId: string): void;
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
    evictExecution: (execId) => useTaskExecutionStore.getState().evictExecution(execId),
  };
}

let current: ExecutionPort = createInProcessExecutionPort();

/** Module-level accessor for the app-wide default ExecutionPort. All core/
 *  callers that don't receive an explicit port via options should go
 *  through this instead of constructing their own in-process port, so
 *  there's a single seam to flip when the headless Node runtime starts up
 *  (see `setExecutionPort`). */
export function getExecutionPort(): ExecutionPort {
  return current;
}

/** One-time swap hook for a future out-of-process (IPC/RPC-backed) port, to
 *  be called once at Node runtime startup. Not used anywhere yet — the
 *  in-process default remains active until a real out-of-process
 *  implementation exists. */
export function setExecutionPort(port: ExecutionPort): void {
  current = port;
}
