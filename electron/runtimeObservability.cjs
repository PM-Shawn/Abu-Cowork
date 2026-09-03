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
  'conversationId',
  'loopId',
  'computerRunId',
  'traceId',
  'toolCallId',
  'stateId',
  'modelId',
  'modelTier',
  'capabilitySource',
  'targetBundleId',
  'targetProcessId',
  'verificationStatus',
  'axTreeHash',
  'elementCount',
  'permissionPath',
  'routeType',
  'turnIndex',
  'activeToolCount',
  'deferredToolCount',
  'computerUseExposed',
  'helperGeneration',
  'helperProtocolVersion',
  'helperBinaryVersion',
  'helperPlatform',
  'command',
  'sandboxEnabled',
  'attemptCount',
  'consecutiveNoChange',
  'recoveryUsed',
  'subscriptionCount',
  'exitCode',
  'windowLabel',
]);

/**
 * The ONE classifier for Electron's `render-process-gone` reasons, used both
 * for the local record's `outcome` and for the remote-report decision.
 *
 * Deliberately a benign-list, not a severe-list: Electron documents eight
 * reasons ('clean-exit' | 'abnormal-exit' | 'killed' | 'crashed' | 'oom' |
 * 'launch-failed' | 'integrity-failure' | 'memory-eviction'), and a severe-list
 * silently drops every reason it forgets — which is how 'abnormal-exit',
 * 'launch-failed', 'integrity-failure' and 'memory-eviction' went unreported.
 * Anything not listed here (including an unknown future reason) counts as a
 * renderer death. 'killed' stays out of this set on purpose: no code path in
 * this repo kills a renderer, so a 'killed' renderer is not a teardown we asked
 * for and is worth hearing about.
 */
const BENIGN_RENDER_PROCESS_REASONS = new Set(['clean-exit']);

/** Window within which the same error object is treated as one main crash. */
const MAIN_CRASH_DEDUPE_WINDOW_MS = 50;

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
      // Durations, counts and byte sizes are non-negative by construction, so a
      // negative one means a bad clock/caller and is clamped. `exitCode` is the
      // exception: a crashed process legitimately reports a negative code
      // (signal- and NTSTATUS-derived exits), and clamping that to 0 would turn
      // the most diagnostic part of a crash record into "exited normally".
      output[key] = key === 'exitCode' ? Math.round(raw) : Math.max(0, Math.round(raw));
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
  const nativeHelpers = new Map();

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

  function noteNativeHelperSpawnStarted(generation, restarted = generation > 1) {
    const startedAt = now();
    nativeHelpers.set(generation, { generation, status: 'starting', startedAt });
    emitEvent('main', 'main.native_helper_spawn_started', {
      helperGeneration: generation,
      stage: 'starting',
    });
    if (restarted) {
      emitEvent('main', 'main.native_helper_restarted', {
        helperGeneration: generation,
        stage: 'restarted',
      });
    }
  }

  function noteNativeHelperReady(generation, hello) {
    const helper = nativeHelpers.get(generation);
    if (helper) helper.status = 'running';
    emitEvent('main', 'main.native_helper_ready', {
      helperGeneration: generation,
      helperProtocolVersion: hello?.protocol_version,
      helperBinaryVersion: hello?.binary_version,
      helperPlatform: hello?.platform,
      stage: 'running',
      outcome: 'success',
      durationMs: helper ? now() - helper.startedAt : undefined,
    });
  }

  function noteNativeHelperSpawnFailed(generation, errorType) {
    const helper = nativeHelpers.get(generation);
    if (helper) helper.status = 'failed';
    emitEvent('main', 'main.native_helper_spawn_failed', {
      helperGeneration: generation,
      stage: 'failed',
      outcome: 'error',
      errorType,
      durationMs: helper ? now() - helper.startedAt : undefined,
    });
  }

  function noteNativeHelperCrashed(generation, reason) {
    const helper = nativeHelpers.get(generation);
    if (helper) helper.status = 'crashed';
    emitEvent('main', 'main.native_helper_crashed', {
      helperGeneration: generation,
      stage: 'crashed',
      outcome: 'error',
      reason,
      durationMs: helper ? now() - helper.startedAt : undefined,
    });
  }

  function noteNativeHelperStopped(generation, reason = 'stopped') {
    const helper = nativeHelpers.get(generation);
    if (helper) helper.status = 'stopped';
    emitEvent('main', 'main.native_helper_stopped', {
      helperGeneration: generation,
      stage: 'stopped',
      outcome: 'success',
      reason,
      durationMs: helper ? now() - helper.startedAt : undefined,
    });
  }

  function noteNativeHelperCallTimeout(generation, command, durationMs) {
    emitEvent('main', 'main.native_helper_call_timeout', {
      helperGeneration: generation,
      command,
      durationMs,
      stage: 'timeout',
      outcome: 'error',
      errorType: 'native_helper_timeout',
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

  function noteCommandFinished({ command, exitCode, durationMs, sandboxEnabled, executionPath } = {}) {
    emitEvent('main', 'main.command_finished', {
      command,
      exitCode,
      durationMs,
      sandboxEnabled,
      executionPath,
      outcome: exitCode === 0 ? 'success' : 'error',
    });
  }

  function noteRendererResourcesCleared(attributes) {
    emitEvent('main', 'main.renderer_resources_cleared', attributes);
  }

  function noteMainUncaughtException(errorType, origin) {
    emitEvent('main', 'main.uncaught_exception', {
      stage: 'uncaught_exception',
      outcome: 'error',
      errorType,
      reason: origin,
    });
  }

  function noteMainUnhandledRejection(errorType) {
    emitEvent('main', 'main.unhandled_rejection', {
      stage: 'unhandled_rejection',
      outcome: 'error',
      errorType,
    });
  }

  function noteRenderProcessGone(windowLabel, details) {
    const reason = details?.reason;
    emitEvent('main', 'main.render_process_gone', {
      windowLabel,
      stage: 'render_process_gone',
      // Same classifier the remote-report decision uses: closing a window is a
      // successful teardown, not an error record to page someone about.
      outcome: BENIGN_RENDER_PROCESS_REASONS.has(reason) ? 'success' : 'error',
      errorType: 'render_process_gone',
      reason,
      exitCode: details?.exitCode,
    });
  }

  function noteRendererUnresponsive(windowLabel) {
    emitEvent('main', 'main.renderer_unresponsive', {
      windowLabel,
      stage: 'renderer_unresponsive',
      outcome: 'stalled',
      errorType: 'renderer_unresponsive',
    });
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
      nativeHelpers: Array.from(nativeHelpers.values(), (helper) => sanitizeAttributes({
        helperGeneration: helper.generation,
        stage: helper.status,
        durationMs: now() - helper.startedAt,
      })),
    };
  }

  function reset() {
    for (const ack of bridgeAcks.values()) clearTimer(ack.timer);
    sidecars.clear();
    pendingRpcs.clear();
    firstDeltaRuns.clear();
    bridgeAcks.clear();
    nativeHelpers.clear();
  }

  return {
    noteSpawnStarted,
    noteSpawnFailed,
    noteReady,
    noteClosed,
    noteKilled,
    noteHeartbeatHung,
    noteNativeHelperSpawnStarted,
    noteNativeHelperReady,
    noteNativeHelperSpawnFailed,
    noteNativeHelperCrashed,
    noteNativeHelperStopped,
    noteNativeHelperCallTimeout,
    noteCommandFinished,
    noteRpcWriteStarted,
    noteRpcWriteFinished,
    noteStdoutLine,
    noteRendererEvent,
    noteRendererResourcesCleared,
    noteMainUncaughtException,
    noteMainUnhandledRejection,
    noteRenderProcessGone,
    noteRendererUnresponsive,
    noteSidecarBridgeDeliveryMissed,
    noteSidecarTraceLine,
    snapshot,
    reset,
  };
}

const appSessionId = randomUUID();
let logFilePath = null;
const recentEvents = [];
// Events recorded before the log path was resolvable. They are already in
// `recentEvents` (so a live diagnostics export sees them), but had nowhere to
// land on disk; configureRuntimeObservability backfills them in one append.
const eventsAwaitingLogFile = [];

function appendLogLines(lines) {
  if (!logFilePath || lines.length === 0) return;
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFilePath, lines.join(''), 'utf8');
  } catch {
    // Observability must never change product behavior.
  }
}

function configureRuntimeObservability(app) {
  if (logFilePath || !app || typeof app.getPath !== 'function') return;
  try {
    const logDir = app.getPath('logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, LOG_FILE_NAME);
  } catch {
    logFilePath = null;
    return;
  }
  // Crashes during the pre-configure window (single-instance lock, deep-link
  // wiring) would otherwise exist only in memory and die with the process.
  const backfill = eventsAwaitingLogFile.splice(0, eventsAwaitingLogFile.length);
  appendLogLines(backfill.map((entry) => `${JSON.stringify(entry)}\n`));
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
  if (!logFilePath) {
    eventsAwaitingLogFile.push(entry);
    if (eventsAwaitingLogFile.length > MAX_RECENT_EVENTS) eventsAwaitingLogFile.shift();
    return;
  }
  appendLogLines([`${JSON.stringify(entry)}\n`]);
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

function describeCrashError(error) {
  if (error instanceof Error) {
    return {
      errorType: normalizeErrorType(error.name || 'error'),
      message: redactString(error.message || ''),
    };
  }
  return {
    errorType: normalizeErrorType(typeof error),
    message: typeof error === 'string' ? redactString(error) : '',
  };
}

/** A crash observer must never become the reason the process misbehaves. */
function safeNotify(onCrash, crash) {
  if (typeof onCrash !== 'function') return;
  try {
    onCrash(crash);
  } catch {
    // Observability must never change product behavior.
  }
}

/**
 * Record main-process crashes WITHOUT changing what the process does next.
 *
 * `uncaughtExceptionMonitor` is deliberate, not a stylistic choice. Electron's
 * own default 'uncaughtException' handler shows its "A JavaScript error
 * occurred in the main process" dialog only while it is the sole listener
 * (`process.listenerCount('uncaughtException') > 1` makes it bail out), and
 * that count is already 1 at app-ready — so a plain `process.on(
 * 'uncaughtException')` recorder would silently swallow the crash dialog.
 * The monitor hook runs before the handlers, cannot preempt them, and leaves
 * the listener count untouched, so existing crash behavior is preserved
 * exactly (verified firsthand on Electron 43 / Node 24).
 *
 * 'unhandledRejection' has no monitor-only variant. Electron 43 runs Node's
 * `warn` mode there (a rejected promise prints
 * UnhandledPromiseRejectionWarning and the app keeps running), so attaching a
 * listener suppresses that warning but cannot change any exit behavior; the
 * caller re-surfaces the diagnostic from `onCrash`.
 *
 * That `warn` assumption is not load-bearing for correctness. Under Node's
 * `strict` mode an unhandled rejection is re-thrown as an uncaught exception,
 * so BOTH hooks would see the same rejection reason and one crash would be
 * recorded and reported twice. The two hooks therefore share a short
 * single-slot dedupe: the same error/reason value seen again within
 * `dedupeWindowMs` is dropped, whichever hook saw it first.
 *
 * @param {NodeJS.Process} processRef
 * @param {{
 *   state?: object,
 *   onCrash?: (crash: object) => void,
 *   now?: () => number,
 *   dedupeWindowMs?: number,
 * }} [options]
 * @returns {() => void} removes both observers
 */
function observeMainProcessCrashes(processRef, {
  state = runtimeState,
  onCrash,
  now = () => Date.now(),
  dedupeWindowMs = MAIN_CRASH_DEDUPE_WINDOW_MS,
} = {}) {
  let lastValue = null;
  let lastSeenAt = -Infinity;
  /** True when this exact error/reason was just recorded by the other hook. */
  const isDuplicate = (value) => {
    const at = now();
    if (Object.is(value, lastValue) && at - lastSeenAt <= dedupeWindowMs) return true;
    lastValue = value;
    lastSeenAt = at;
    return false;
  };
  const onMonitor = (error, origin) => {
    if (isDuplicate(error)) return;
    const described = describeCrashError(error);
    state.noteMainUncaughtException(described.errorType, origin);
    safeNotify(onCrash, { kind: 'main_uncaught_exception', ...described, reason: origin });
  };
  const onRejection = (reason) => {
    if (isDuplicate(reason)) return;
    const described = describeCrashError(reason);
    state.noteMainUnhandledRejection(described.errorType);
    safeNotify(onCrash, { kind: 'main_unhandled_rejection', ...described });
  };
  processRef.on('uncaughtExceptionMonitor', onMonitor);
  processRef.on('unhandledRejection', onRejection);
  return () => {
    processRef.removeListener('uncaughtExceptionMonitor', onMonitor);
    processRef.removeListener('unhandledRejection', onRejection);
  };
}

/**
 * Record renderer death and renderer hangs for one window's WebContents.
 * Purely observational: nothing here reloads, recovers, or closes the window,
 * so a crash keeps whatever outcome it had before.
 *
 * @param {import('electron').WebContents} webContents
 * @param {string} windowLabel
 * @param {{ state?: object, onCrash?: (crash: object) => void }} [options]
 * @returns {() => void} removes both observers
 */
function observeWebContentsCrashes(webContents, windowLabel, { state = runtimeState, onCrash } = {}) {
  // Per-WebContents (never module-level) hang latch, so one window hanging
  // cannot mask another window's hang.
  let isUnresponsive = false;
  const onGone = (_event, details) => {
    // The render process that was hanging is gone; a replacement one starts
    // healthy and 'responsive' will not fire for it.
    isUnresponsive = false;
    state.noteRenderProcessGone(windowLabel, details);
    // A hang or a clean teardown is not worth a remote report; every other
    // way a renderer can die is (see BENIGN_RENDER_PROCESS_REASONS).
    if (BENIGN_RENDER_PROCESS_REASONS.has(details?.reason)) return;
    safeNotify(onCrash, {
      kind: 'renderer_process_gone',
      errorType: 'render_process_gone',
      reason: details?.reason,
      message: '',
    });
  };
  const onUnresponsive = () => {
    // Chromium re-fires 'unresponsive' for as long as one hang lasts. Record
    // the healthy→hung transition only; otherwise a single stuck renderer
    // would drive an unbounded stream of synchronous appendFileSync calls on
    // the main process (same latch shape as mcpBridge's heartbeat timeout).
    if (isUnresponsive) return;
    isUnresponsive = true;
    state.noteRendererUnresponsive(windowLabel);
  };
  const onResponsive = () => {
    isUnresponsive = false;
  };
  webContents.on('render-process-gone', onGone);
  webContents.on('unresponsive', onUnresponsive);
  webContents.on('responsive', onResponsive);
  return () => {
    webContents.removeListener('render-process-gone', onGone);
    webContents.removeListener('unresponsive', onUnresponsive);
    webContents.removeListener('responsive', onResponsive);
  };
}

module.exports = {
  RUNTIME_EVENT_CHANNEL,
  RUNTIME_DIAGNOSTICS_CHANNEL,
  SIDECAR_TRACE_PREFIX,
  configureRuntimeObservability,
  getRuntimeDiagnostics,
  observeMainProcessCrashes,
  observeWebContentsCrashes,
  runtimeState,
  sanitizeAttributes,
  parseJsonRpcMetadata,
  createRuntimeState,
};
