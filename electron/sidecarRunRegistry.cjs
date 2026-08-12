'use strict';

const SIDECAR_ID = 'abu-sidecar';
const DEFAULT_MAX_EVENTS = 512;
const DEFAULT_MAX_EVENT_CHARS = 16 * 1024 * 1024;
const DEFAULT_MAX_RUNS = 128;
const TERMINAL_TTL_MS = 60 * 60 * 1_000;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rpcKey(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function parseLine(line) {
  if (typeof line !== 'string') return null;
  try {
    const parsed = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function createSidecarRunRegistry({
  maxEvents = DEFAULT_MAX_EVENTS,
  maxEventChars = DEFAULT_MAX_EVENT_CHARS,
  maxRuns = DEFAULT_MAX_RUNS,
  maxPendingRequests = DEFAULT_MAX_RUNS * 2,
  now = () => Date.now(),
} = {}) {
  let generation = 0;
  let nextSequence = 1;
  let bridgeStatus = 'stopped';
  const events = [];
  const runs = new Map();
  const pendingRequests = new Map();
  let eventChars = 0;
  let lastDroppedSequence = 0;

  function pruneRuns() {
    const cutoff = now() - TERMINAL_TTL_MS;
    for (const [runId, run] of runs) {
      if (run.state === 'terminal' && (run.terminalAt ?? run.updatedAt) < cutoff) {
        runs.delete(runId);
      }
    }
    if (runs.size <= maxRuns) return;
    const removable = [...runs.values()]
      .filter((run) => run.state === 'terminal')
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const run of removable) {
      if (runs.size <= maxRuns) break;
      runs.delete(run.runId);
    }
    if (runs.size <= maxRuns) return;
    // Main is a bounded recovery mirror, not the execution owner. When every
    // entry is non-terminal, retain the newest facts and evict the oldest;
    // the sidecar's run.getState remains authoritative for live execution.
    const oldestActive = [...runs.values()]
      .filter((run) => run.state !== 'terminal')
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const run of oldestActive) {
      if (runs.size <= maxRuns) break;
      runs.delete(run.runId);
    }
  }

  function upsertRun(runId, patch = {}) {
    if (typeof runId !== 'string' || !runId) return;
    const current = runs.get(runId) ?? {
      runId,
      state: 'pending',
      generation,
      updatedAt: now(),
    };
    // First terminal fact wins, including against a conflicting later
    // terminal. This matches renderer and sidecar terminal semantics.
    if (current.state === 'terminal') return;
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const next = {
      ...current,
      ...definedPatch,
      runId,
      generation: definedPatch.generation ?? generation,
      updatedAt: now(),
    };
    runs.set(runId, next);
    pruneRuns();
  }

  function beginGeneration() {
    generation += 1;
    bridgeStatus = 'starting';
    pendingRequests.clear();
    return generation;
  }

  function markReady() {
    bridgeStatus = 'running';
  }

  function markDisconnected(reason = 'closed') {
    bridgeStatus = reason === 'hung' ? 'hung' : 'disconnected';
  }

  function observeOutbound(line) {
    const message = parseLine(line);
    if (!message || typeof message.method !== 'string') return;
    const params = isRecord(message.params) ? message.params : {};
    const runId = typeof params.runId === 'string' ? params.runId : undefined;
    const id = rpcKey(message.id);
    // Only these responses can update the recovery mirror. Tracking every
    // renderer request would retain an unbounded amount of irrelevant RPC
    // metadata while a long-lived process handles tool calls.
    if (id && (message.method === 'agent.start' || message.method === 'run.getState')) {
      pendingRequests.set(id, { method: message.method, runId });
      while (pendingRequests.size > maxPendingRequests) {
        pendingRequests.delete(pendingRequests.keys().next().value);
      }
    }

    if (message.method === 'agent.start' && runId) {
      upsertRun(runId, {
        state: 'pending',
        clientMessageId: typeof params.clientMessageId === 'string' ? params.clientMessageId : undefined,
        payloadDigest: typeof params.payloadDigest === 'string' ? params.payloadDigest : undefined,
      });
    } else if (message.method === 'agent.run' && runId) {
      upsertRun(runId, { state: 'running' });
    }
  }

  function applyState(runId, result) {
    if (!runId || !isRecord(result)) return;
    const state = result.state;
    if (!['accepted', 'running', 'terminal'].includes(state)) return;
    const terminal = isRecord(result.terminal) ? result.terminal : undefined;
    // A terminal state without its immutable terminal fact cannot safely win:
    // it would block the later, complete agent.terminal notification.
    if (state === 'terminal' && !terminal) return;
    upsertRun(runId, {
      state,
      clientMessageId: typeof result.clientMessageId === 'string' ? result.clientMessageId : undefined,
      acceptedAt: Number.isFinite(result.acceptedAt) ? result.acceptedAt : undefined,
      ...(terminal ? { terminal, terminalAt: now() } : {}),
    });
  }

  function observeInbound(line) {
    const message = parseLine(line);
    if (!message) return;
    if (typeof message.method === 'string') {
      const params = isRecord(message.params) ? message.params : {};
      const runId = typeof params.runId === 'string' ? params.runId : undefined;
      if (message.method === 'agent.delta' && runId) upsertRun(runId, { state: 'running' });
      if (message.method === 'agent.terminal' && runId) {
        upsertRun(runId, { state: 'terminal', terminal: params, terminalAt: now() });
      }
      return;
    }

    const id = rpcKey(message.id);
    if (!id) return;
    const pending = pendingRequests.get(id);
    if (!pending) return;
    pendingRequests.delete(id);
    if (message.error) return;
    if (pending.method === 'agent.start' || pending.method === 'run.getState') {
      applyState(pending.runId, message.result);
    }
  }

  function recordEvent(type, payload) {
    const safePayload = typeof payload === 'string' ? payload : '';
    const event = {
      type,
      payload: safePayload,
      sequence: nextSequence++,
      generation,
    };
    if (safePayload.length <= maxEventChars) {
      events.push(event);
      eventChars += safePayload.length;
    } else {
      lastDroppedSequence = event.sequence;
    }
    while (events.length > maxEvents || eventChars > maxEventChars) {
      const removed = events.shift();
      eventChars -= removed?.payload.length ?? 0;
    }
    return event;
  }

  function snapshot(afterSequence = 0) {
    const safeAfter = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const firstAvailableSequence = events[0]?.sequence ?? nextSequence;
    return {
      version: 1,
      sidecarId: SIDECAR_ID,
      generation,
      bridgeStatus,
      lastSequence: nextSequence - 1,
      firstAvailableSequence,
      truncated:
        safeAfter < firstAvailableSequence - 1
        || lastDroppedSequence > safeAfter,
      events: events.filter((event) => event.sequence > safeAfter),
      runs: [...runs.values()].map((run) => ({ ...run })),
    };
  }

  function reset() {
    generation = 0;
    nextSequence = 1;
    bridgeStatus = 'stopped';
    events.length = 0;
    eventChars = 0;
    lastDroppedSequence = 0;
    runs.clear();
    pendingRequests.clear();
  }

  return {
    beginGeneration,
    markReady,
    markDisconnected,
    observeOutbound,
    observeInbound,
    recordEvent,
    snapshot,
    reset,
  };
}

const sidecarRunRegistry = createSidecarRunRegistry();

module.exports = {
  SIDECAR_ID,
  createSidecarRunRegistry,
  sidecarRunRegistry,
};
