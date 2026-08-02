import type { ToolExecutionContext } from '@/types';
import type { CapabilitySetupTarget } from './types';

export interface CapabilitySetupRequest {
  id: string;
  target: CapabilitySetupTarget;
  source: 'task';
  conversationId: string;
  loopId?: string;
  toolCallId: string;
}

interface PendingEntry {
  request: CapabilitySetupRequest;
  resolve: (ready: boolean) => void;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

const listeners = new Set<() => void>();
const queue: PendingEntry[] = [];
let active: PendingEntry | null = null;
let requestCounter = 0;
const SETUP_TIMEOUT_MS = 5 * 60 * 1000;

function notify(): void {
  listeners.forEach((listener) => listener());
}

function cleanupAbortListener(entry: PendingEntry): void {
  if (entry.abortSignal && entry.onAbort) {
    entry.abortSignal.removeEventListener('abort', entry.onAbort);
  }
  if (entry.timer) clearTimeout(entry.timer);
}

function promoteNext(): void {
  active = queue.shift() ?? null;
  notify();
}

function settleEntry(entry: PendingEntry, ready: boolean): void {
  cleanupAbortListener(entry);
  entry.resolve(ready);
}

function cancelById(id: string): void {
  if (active?.request.id === id) {
    const entry = active;
    active = null;
    settleEntry(entry, false);
    promoteNext();
    return;
  }

  const index = queue.findIndex((entry) => entry.request.id === id);
  if (index === -1) return;
  const [entry] = queue.splice(index, 1);
  if (entry) settleEntry(entry, false);
}

/**
 * Suspends one task tool call until the user completes or cancels capability
 * setup. Each request remains bound to its originating conversation/tool call,
 * and its abort signal removes it from the queue immediately.
 */
export function requestCapabilitySetup(
  target: CapabilitySetupTarget,
  context: ToolExecutionContext,
): Promise<boolean> {
  const conversationId = context.conversationId;
  const toolCallId = context.toolCallId;
  if (!conversationId || !toolCallId || context.abortSignal?.aborted) {
    return Promise.resolve(false);
  }
  if (context.interactionMode !== 'foreground') {
    return Promise.resolve(false);
  }

  requestCounter += 1;
  const request: CapabilitySetupRequest = {
    id: `${conversationId}:${toolCallId}:${requestCounter}`,
    target,
    source: 'task',
    conversationId,
    loopId: context.loopId,
    toolCallId,
  };

  return new Promise<boolean>((resolve) => {
    const entry: PendingEntry = {
      request,
      resolve,
      abortSignal: context.abortSignal,
    };
    if (context.abortSignal) {
      entry.onAbort = () => cancelById(request.id);
      context.abortSignal.addEventListener('abort', entry.onAbort, { once: true });
    }
    entry.timer = setTimeout(() => cancelById(request.id), SETUP_TIMEOUT_MS);

    if (active) {
      queue.push(entry);
      return;
    }
    active = entry;
    notify();
  });
}

export function subscribeCapabilitySetup(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPendingCapabilitySetup(): CapabilitySetupRequest | null {
  return active?.request ?? null;
}

export function resolveCapabilitySetup(id: string, ready: boolean): void {
  if (active?.request.id !== id) return;
  const entry = active;
  active = null;
  settleEntry(entry, ready);
  promoteNext();
}

export function drainCapabilitySetupRequests(loopId?: string): void {
  const all = active ? [active, ...queue] : [...queue];
  const entries = loopId
    ? all.filter((entry) => entry.request.loopId === loopId)
    : all;
  if (entries.length === 0) return;
  const entryIds = new Set(entries.map((entry) => entry.request.id));
  if (active && entryIds.has(active.request.id)) active = null;
  const retained = queue.filter((entry) => !entryIds.has(entry.request.id));
  queue.length = 0;
  queue.push(...retained);
  for (const entry of entries) settleEntry(entry, false);
  if (!active) active = queue.shift() ?? null;
  notify();
}
