'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const RUNTIME_EVENT_CHANNEL = 'abu:runtime-event';
const RUNTIME_DIAGNOSTICS_CHANNEL = 'abu:runtime-diagnostics';
const SIDECAR_TRACE_PREFIX = '[abu-runtime] ';
const SIDECAR_ID = 'abu-sidecar';
const SCHEMA_VERSION = 1;
const LOG_FILE_NAME = 'runtime-observability.jsonl';
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_RECENT_EVENTS = 1_000;
const MAX_STRING_CHARS = 160;
const BRIDGE_ACK_TIMEOUT_MS = 3_000;

const SAFE_ATTRIBUTE_KEYS = new Set([
  'runId',
  'clientMessageId',
  'rpcId',
  'method',
  'stage',
  'outcome',
  'errorType',
  'sidecarId',
  'sidecarGeneration',
  'durationMs',
  'payloadBytes',
  'frameCount',
  'pendingRpcCount',
  'reason',
  'executionPath',
  'firstFrameMs',
  'bridgeLatencyMs',
  'acceptedAt',
  'replayCount',
  'subscriptionCount',
]);

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{12,}/g,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/g,
  /\bBearer\s+[a-zA-Z0-9._\-+/=]{8,}/gi,
  /\b(?:token|api[_-]?key|password|secret|authorization)\s*[=:]\s*\S+/gi,
];

function redactString(value) {
  let result = String(value);
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[REDACTED]');
  return result.slice(0, MAX_STRING_CHARS);
}

function normalizeErrorType(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 80) || 'unknown';
}

function sanitizeAttributes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key) || raw === undefined) continue;
    if (raw === null || typeof raw === 'boolean') {
      output[key] = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      output[key] = Math.max(0, Math.round(raw));
    } else if (typeof raw === 'string') {
      output[key] = key === 'errorType' ? normalizeErrorType(raw) : redactString(raw);
    }
  }
  return output;
}

function sanitizeEventName(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(value)) return null;
  return value;
}

function parseJsonRpcMetadata(message) {
  if (typeof message !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const method = typeof parsed.method === 'string' ? parsed.method.slice(0, 80) : undefined;
  const rpcId = typeof parsed.id === 'string' || typeof parsed.id === 'number'
    ? String(parsed.id).slice(0, 80)
    : undefined;
  const params = parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params)
    ? parsed.params
    : null;
  const runId = typeof params?.runId === 'string' ? params.runId.slice(0, MAX_STRING_CHARS) : undefined;
  const frames = Array.isArray(params?.frames) ? params.frames : null;
  return {
    method,
    rpcId,
    runId,
    frameCount: frames ? frames.length : undefined,
    payloadBytes: Buffer.byteLength(message),
  };
}

function createRuntimeState({
  emit,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  bridgeAckTimeoutMs = BRIDGE_ACK_TIMEOUT_MS,
} = {}) {
  const sidecars = new Map();
  const pendingRpcs = new Map();
  const firstDeltaRuns = new Set();
  const bridgeAcks = new Map();

  const emitEvent = (processName, event, attributes) => {
    emit?.(processName, event, sanitizeAttributes(attributes));
  };
  const sidecarGeneration = (id) => sidecars.get(id)?.generation ?? 0;
  const pendingKey = (id, rpcId) => `${id}:${rpcId}`;

  function noteSpawnStarted(id, heartbeat) {
    if (id !== SIDECAR_ID) return 0;
    const generation = sidecarGeneration(id) + 1;
    sidecars.set(id, {
      id,
      generation,
      status: 'starting',
      heartbeat: heartbeat === true,
      startedAt: now(),
      readyAt: null,
      targetPid: null,
    });
    emitEvent('main', 'main.sidecar_spawn_started', {
      sidecarId: id,
      sidecarGeneration: generation,
      stage: 'starting',
    });
    return generation;
  }

  function noteSpawnFailed(id, generation, errorType) {
    if (id !== SIDECAR_ID) return;
    const current = sidecars.get(id);
    if (current?.generation === generation) current.status = 'failed';
    emitEvent('main', 'main.sidecar_spawn_failed', {
      sidecarId: id,
      sidecarGeneration: generation,
      outcome: 'error',
      errorType,
    });
  }

  function noteReady(id, generation, targetPid) {
    if (id !== SIDECAR_ID) return;
    const current = sidecars.get(id);
    if (current?.generation !== generation) return;
    current.status = 'running';
    current.readyAt = now();
    current.targetPid = Number.isInteger(targetPid) ? targetPid : null;
    emitEvent('main', 'main.sidecar_ready', {
      sidecarId: id,
      sidecarGeneration: generation,
      durationMs: current.readyAt - current.startedAt,
      outcome: 'success',
    });
  }

  function clearPendingForSidecar(id, generation) {
    for (const [key, rpc] of pendingRpcs) {
      if (rpc.sidecarId !== id) continue;
      emitEvent('main', 'main.rpc_orphaned_on_sidecar_close', {
        ...rpc,
        sidecarGeneration: generation,
        durationMs: now() - rpc.startedAt,
        outcome: 'error',
        errorType: 'sidecar_closed',
      });
      pendingRpcs.delete(key);
    }
  }

  function noteClosed(id, generation, reason = 'closed') {
    if (id !== SIDECAR_ID) return;
    const current = sidecars.get(id);
    if (current?.generation === generation) current.status = 'stopped';
    clearPendingForSidecar(id, generation);
    emitEvent('main', 'main.sidecar_closed', {
      sidecarId: id,
      sidecarGeneration: generation,
      outcome: 'error',
      reason,
    });
  }

  function noteKilled(id, reason = 'killed') {
    if (id !== SIDECAR_ID) return;
    noteClosed(id, sidecarGeneration(id), reason);
  }

  function noteHeartbeatHung(id) {
    if (id !== SIDECAR_ID) return;
    emitEvent('main', 'main.sidecar_heartbeat_hung', {
      sidecarId: id,
      sidecarGeneration: sidecarGeneration(id),
      outcome: 'stalled',
      errorType: 'heartbeat_timeout',
    });
  }

  function noteRpcWriteStarted(id, message) {
    if (id !== SIDECAR_ID) return null;
    const metadata = parseJsonRpcMetadata(message);
    if (!metadata?.method || !['agent.run', 'agent.abort'].includes(metadata.method)) return null;
    const startedAt = now();
    const rpc = {
      sidecarId: id,
      sidecarGeneration: sidecarGeneration(id),
      runId: metadata.runId,
      rpcId: metadata.rpcId,
      method: metadata.method,
      payloadBytes: metadata.payloadBytes,
      stage: 'stdin_write',
      startedAt,
    };
    if (metadata.rpcId) pendingRpcs.set(pendingKey(id, metadata.rpcId), rpc);
    emitEvent('main', 'main.rpc_write_started', rpc);
    return rpc;
  }

  function noteRpcWriteFinished(rpc, errorType) {
    if (!rpc) return;
    emitEvent('main', errorType ? 'main.rpc_write_failed' : 'main.rpc_write_completed', {
      ...rpc,
      stage: errorType ? 'stdin_write_failed' : 'waiting_for_response',
      durationMs: now() - rpc.startedAt,
      outcome: errorType ? 'error' : 'success',
      errorType,
    });
    if (errorType && rpc.rpcId) pendingRpcs.delete(pendingKey(rpc.sidecarId, rpc.rpcId));
  }

  function noteStdoutLine(id, line) {
    if (id !== SIDECAR_ID) return;
    const metadata = parseJsonRpcMetadata(line);
    if (!metadata) return;

    if (metadata.method === 'agent.delta' && metadata.runId && (metadata.frameCount ?? 0) > 0) {
      if (firstDeltaRuns.has(metadata.runId)) return;
      firstDeltaRuns.add(metadata.runId);
      const receivedAt = now();
      emitEvent('main', 'main.agent_delta_received', {
        sidecarId: id,
        sidecarGeneration: sidecarGeneration(id),
        runId: metadata.runId,
        frameCount: metadata.frameCount,
        stage: 'waiting_for_renderer_ack',
      });
      const timer = setTimer(() => {
        bridgeAcks.delete(metadata.runId);
        emitEvent('main', 'main.renderer_bridge_ack_timeout', {
          sidecarId: id,
          sidecarGeneration: sidecarGeneration(id),
          runId: metadata.runId,
          durationMs: now() - receivedAt,
          outcome: 'stalled',
          errorType: 'renderer_ack_timeout',
        });
      }, bridgeAckTimeoutMs);
      bridgeAcks.set(metadata.runId, { receivedAt, timer });
      return;
    }

    if (!metadata.rpcId) return;
    const key = pendingKey(id, metadata.rpcId);
    const rpc = pendingRpcs.get(key);
    if (!rpc) return;
    pendingRpcs.delete(key);
    emitEvent('main', 'main.rpc_response_received', {
      ...rpc,
      stage: 'response_received',
      durationMs: now() - rpc.startedAt,
      outcome: 'success',
    });
  }

  function noteRendererEvent(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const event = sanitizeEventName(raw.event);
    if (!event || !event.startsWith('renderer.')) return false;
    const attributes = sanitizeAttributes(raw);
    emitEvent('renderer', event, attributes);
    if (event !== 'renderer.agent_delta_received' || typeof attributes.runId !== 'string') return true;
    const ack = bridgeAcks.get(attributes.runId);
    if (!ack) return true;
    clearTimer(ack.timer);
    bridgeAcks.delete(attributes.runId);
    emitEvent('main', 'main.renderer_bridge_ack_received', {
      runId: attributes.runId,
      sidecarId: SIDECAR_ID,
      sidecarGeneration: sidecarGeneration(SIDECAR_ID),
      bridgeLatencyMs: now() - ack.receivedAt,
      outcome: 'success',
    });
    return true;
  }

  function noteRendererResourcesCleared(attributes) {
    emitEvent('main', 'main.renderer_resources_cleared', attributes);
  }

  function noteSidecarBridgeDeliveryMissed(stage) {
    emitEvent('main', 'main.sidecar_bridge_delivery_missed', {
      sidecarId: SIDECAR_ID,
      sidecarGeneration: sidecarGeneration(SIDECAR_ID),
      stage,
      outcome: 'dropped',
      reason: 'no_live_renderer_transport',
    });
  }

  function noteSidecarTraceLine(id, line) {
    if (id !== SIDECAR_ID || typeof line !== 'string' || !line.startsWith(SIDECAR_TRACE_PREFIX)) return false;
    let parsed;
    try {
      parsed = JSON.parse(line.slice(SIDECAR_TRACE_PREFIX.length));
    } catch {
      return false;
    }
    const event = sanitizeEventName(parsed?.event);
    if (!event || !event.startsWith('sidecar.')) return false;
    emitEvent('sidecar', event, {
      ...parsed,
      sidecarId: id,
      sidecarGeneration: sidecarGeneration(id),
    });
    return true;
  }

  function snapshot() {
    return {
      pendingRpcs: Array.from(pendingRpcs.values(), (rpc) => sanitizeAttributes({
        ...rpc,
        durationMs: now() - rpc.startedAt,
      })),
      sidecars: Array.from(sidecars.values(), (sidecar) => sanitizeAttributes({
        sidecarId: sidecar.id,
        sidecarGeneration: sidecar.generation,
        stage: sidecar.status,
        durationMs: now() - sidecar.startedAt,
      })),
      pendingRendererAcks: Array.from(bridgeAcks, ([runId, ack]) => sanitizeAttributes({
        runId,
        stage: 'waiting_for_renderer_ack',
        durationMs: now() - ack.receivedAt,
      })),
    };
  }

  function reset() {
    for (const ack of bridgeAcks.values()) clearTimer(ack.timer);
    sidecars.clear();
    pendingRpcs.clear();
    firstDeltaRuns.clear();
    bridgeAcks.clear();
  }

  return {
    noteSpawnStarted,
    noteSpawnFailed,
    noteReady,
    noteClosed,
    noteKilled,
    noteHeartbeatHung,
    noteRpcWriteStarted,
    noteRpcWriteFinished,
    noteStdoutLine,
    noteRendererEvent,
    noteRendererResourcesCleared,
    noteSidecarBridgeDeliveryMissed,
    noteSidecarTraceLine,
    snapshot,
    reset,
  };
}

const appSessionId = randomUUID();
let logFilePath = null;
const recentEvents = [];

function configureRuntimeObservability(app) {
  if (logFilePath || !app || typeof app.getPath !== 'function') return;
  try {
    const logDir = app.getPath('logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, LOG_FILE_NAME);
  } catch {
    logFilePath = null;
  }
}

function rotateIfNeeded() {
  if (!logFilePath) return;
  try {
    if (!fs.existsSync(logFilePath) || fs.statSync(logFilePath).size < MAX_LOG_BYTES) return;
    const oldPath = `${logFilePath}.old`;
    fs.rmSync(oldPath, { force: true });
    fs.renameSync(logFilePath, oldPath);
  } catch {
    // Observability must never change product behavior.
  }
}

function emitRuntimeEvent(processName, event, attributes) {
  const safeEvent = sanitizeEventName(event);
  if (!safeEvent || !['renderer', 'main', 'sidecar'].includes(processName)) return;
  const entry = {
    schemaVersion: SCHEMA_VERSION,
    timestamp: Date.now(),
    process: processName,
    event: safeEvent,
    appSessionId,
    ...sanitizeAttributes(attributes),
  };
  recentEvents.push(entry);
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
  if (!logFilePath) return;
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Observability must never change product behavior.
  }
}

const runtimeState = createRuntimeState({ emit: emitRuntimeEvent });

function readPersistedEvents() {
  const paths = logFilePath ? [`${logFilePath}.old`, logFilePath] : [];
  const lines = [];
  for (const filePath of paths) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const event = sanitizeEventName(parsed?.event);
          const processName = ['renderer', 'main', 'sidecar'].includes(parsed?.process) ? parsed.process : null;
          if (parsed?.schemaVersion === SCHEMA_VERSION && event && processName) {
            lines.push(JSON.stringify({
              schemaVersion: SCHEMA_VERSION,
              timestamp: Number.isFinite(parsed.timestamp) ? Math.max(0, Math.round(parsed.timestamp)) : 0,
              process: processName,
              event,
              appSessionId: redactString(parsed.appSessionId || 'unknown'),
              ...sanitizeAttributes(parsed),
            }));
          }
        } catch {
          // Ignore a partial final line after an abrupt process exit.
        }
      }
    } catch {
      // Missing/unreadable log files are valid on a fresh install.
    }
  }
  return lines.slice(-MAX_RECENT_EVENTS);
}

function getRuntimeDiagnostics() {
  const mergedEventLines = new Set(readPersistedEvents());
  for (const event of recentEvents) mergedEventLines.add(JSON.stringify(event));
  return {
    schemaVersion: SCHEMA_VERSION,
    appSessionId,
    recentEventLines: Array.from(mergedEventLines).slice(-MAX_RECENT_EVENTS),
    ...runtimeState.snapshot(),
  };
}

module.exports = {
  RUNTIME_EVENT_CHANNEL,
  RUNTIME_DIAGNOSTICS_CHANNEL,
  SIDECAR_TRACE_PREFIX,
  configureRuntimeObservability,
  getRuntimeDiagnostics,
  runtimeState,
  sanitizeAttributes,
  parseJsonRpcMetadata,
  createRuntimeState,
};
