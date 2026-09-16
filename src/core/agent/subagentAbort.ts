/**
 * Per-subagent AbortController management.
 *
 * Each subagent gets its own AbortController that:
 * 1. Can be cancelled independently without affecting parent or siblings
 * 2. Is automatically cancelled when the parent signal aborts (cascade)
 * 3. Tracks active subagents for UI visibility
 */

import { clearDispatchInputs } from './dispatchInput';

/** Active subagent entry */
interface ActiveSubagent {
  id: string;
  agentName: string;
  controller: AbortController;
  parentCleanup: () => void; // remove parent signal listener
  startTime: number;
  /** `${toolCallId}:${taskIndex}` of the hand-off this run serves (team member stop). */
  dispatchKey?: string;
}

// Module-level registry of active subagent controllers
const activeSubagents = new Map<string, ActiveSubagent>();
// Hand-off key → subagent id, so the UI can stop ONE member without touching
// the leader or its siblings (in-conversation team, block E).
const dispatchIndex = new Map<string, string>();

// Listeners for UI state updates
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach(fn => fn());
}

/**
 * Create a child AbortController linked to a parent signal.
 * Returns the subagent ID and the child signal.
 */
export function createSubagentController(
  agentName: string,
  parentSignal?: AbortSignal,
  dispatchKey?: string,
): { subagentId: string; signal: AbortSignal; cleanup: () => void } {
  const id = `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const controller = new AbortController();

  // If parent is already aborted, immediately abort child
  if (parentSignal?.aborted) {
    controller.abort();
  }

  // Wire parent abort → child abort (cascade)
  let parentCleanup = () => {};
  if (parentSignal) {
    const onParentAbort = () => controller.abort();
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    parentCleanup = () => parentSignal.removeEventListener('abort', onParentAbort);
  }

  const entry: ActiveSubagent = {
    id,
    agentName,
    controller,
    parentCleanup,
    startTime: Date.now(),
    ...(dispatchKey ? { dispatchKey } : {}),
  };

  activeSubagents.set(id, entry);
  if (dispatchKey) dispatchIndex.set(dispatchKey, id);
  notifyListeners();

  const cleanup = () => {
    removeSubagent(id);
  };

  return { subagentId: id, signal: controller.signal, cleanup };
}

/**
 * Cancel a specific subagent by ID (without affecting parent or siblings)
 */
export function cancelSubagent(subagentId: string, reason?: string): boolean {
  const entry = activeSubagents.get(subagentId);
  if (!entry) return false;

  // A string reason rides on the signal so the member's abort result can say
  // WHY it was stopped (e.g. the stall watchdog) to the leader.
  entry.controller.abort(reason);
  removeSubagent(subagentId);
  return true;
}

/**
 * Remove a subagent from tracking (called on completion or cancellation)
 */
function removeSubagent(subagentId: string) {
  const entry = activeSubagents.get(subagentId);
  if (entry) {
    entry.parentCleanup();
    activeSubagents.delete(subagentId);
    if (entry.dispatchKey && dispatchIndex.get(entry.dispatchKey) === subagentId) {
      dispatchIndex.delete(entry.dispatchKey);
      clearDispatchInputs(entry.dispatchKey);
    }
    notifyListeners();
  }
}

/**
 * Get list of active subagents (for UI display)
 */
export function getActiveSubagents(): Array<{ id: string; agentName: string; startTime: number }> {
  return Array.from(activeSubagents.values()).map(({ id, agentName, startTime }) => ({
    id,
    agentName,
    startTime,
  }));
}

/**
 * Subscribe to active subagent list changes (for useSyncExternalStore)
 */
export function subscribeToActiveSubagents(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Cancel all active subagents (cleanup on conversation reset)
 */
export function cancelAllSubagents() {
  for (const entry of activeSubagents.values()) {
    entry.controller.abort();
    entry.parentCleanup();
    if (entry.dispatchKey) clearDispatchInputs(entry.dispatchKey);
  }
  activeSubagents.clear();
  dispatchIndex.clear();
  notifyListeners();
}

/** Stop one hand-off (`${toolCallId}:${taskIndex}`); false when nothing is running under that key. */
export function cancelDispatch(dispatchKey: string, reason?: string): boolean {
  const id = dispatchIndex.get(dispatchKey);
  if (!id) return false;
  return cancelSubagent(id, reason);
}

/** Is a hand-off with this key still running in this process? */
export function isDispatchActive(dispatchKey: string): boolean {
  return dispatchIndex.has(dispatchKey);
}

/**
 * Run a hand-off under its own controller (parent abort still cascades) so it
 * can be stopped by key; the registry entry is removed when the run settles.
 */
export async function withDispatchController<T>(
  agentName: string,
  parentSignal: AbortSignal | undefined,
  dispatchKey: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { signal, cleanup } = createSubagentController(agentName, parentSignal, dispatchKey);
  try {
    return await run(signal);
  } finally {
    cleanup();
  }
}
