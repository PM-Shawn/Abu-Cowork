'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { EventEmitter } = require('node:events');

const {
  SIDECAR_TRACE_PREFIX,
  createRuntimeState,
  observeMainProcessCrashes,
  observeWebContentsCrashes,
  parseJsonRpcMetadata,
  sanitizeAttributes,
} = require('./runtimeObservability.cjs');

function makeHarness() {
  let now = 1_000;
  let nextTimerId = 1;
  const timers = new Map();
  const events = [];
  const state = createRuntimeState({
    emit: (processName, event, attributes) => events.push({ processName, event, attributes }),
    now: () => now,
    setTimer: (callback) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    bridgeAckTimeoutMs: 3_000,
  });
  return {
    state,
    events,
    timers,
    advance(ms) { now += ms; },
    fireTimers() {
      for (const [id, callback] of Array.from(timers)) {
        timers.delete(id);
        callback();
      }
    },
  };
}

test('runtime attributes are allowlisted, bounded, and secret-redacted', () => {
  const safe = sanitizeAttributes({
    runId: 'run-1',
    stage: `authorization=Bearer abcdefghijklmnop ${'x'.repeat(300)}`,
    payloadBytes: 12.8,
    rawBody: 'must never escape',
    prompt: 'must never escape',
  });
  assert.equal(safe.runId, 'run-1');
  assert.match(safe.stage, /\[REDACTED\]/);
  assert.ok(safe.stage.length <= 160);
  assert.equal(safe.payloadBytes, 13);
  assert.equal('rawBody' in safe, false);
  assert.equal('prompt' in safe, false);
});

test('JSON-RPC metadata excludes user content while retaining routing diagnostics', () => {
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 42,
    method: 'agent.run',
    params: {
      runId: 'run-safe',
      userMessage: 'private conversation text',
      resolvedCreds: { apiKey: 'sk-never-log-this-value' },
      frames: [{ type: 'text', text: 'secret' }],
    },
  });
  assert.deepEqual(parseJsonRpcMetadata(raw), {
    method: 'agent.run',
    rpcId: '42',
    runId: 'run-safe',
    frameCount: 1,
    payloadBytes: Buffer.byteLength(raw),
  });
});

test('tracks an agent RPC until its response and captures sidecar lifecycle', () => {
  const h = makeHarness();
  const generation = h.state.noteSpawnStarted('abu-sidecar', true);
  h.advance(40);
  h.state.noteReady('abu-sidecar', generation, 1234);
  const request = JSON.stringify({ jsonrpc: '2.0', id: 'rpc-1', method: 'agent.run', params: { runId: 'run-1' } });
  const pending = h.state.noteRpcWriteStarted('abu-sidecar', request);
  h.state.noteRpcWriteFinished(pending);
  assert.equal(h.state.snapshot().pendingRpcs.length, 1);
  h.advance(20);
  h.state.noteStdoutLine('abu-sidecar', JSON.stringify({ jsonrpc: '2.0', id: 'rpc-1', result: { reason: 'completed' } }));
  assert.equal(h.state.snapshot().pendingRpcs.length, 0);
  assert.deepEqual(h.state.snapshot().sidecars[0], {
    sidecarId: 'abu-sidecar',
    sidecarGeneration: 1,
    stage: 'running',
    durationMs: 60,
  });
  assert.ok(h.events.some((entry) => entry.event === 'main.rpc_response_received'));
});

test('distinguishes a healthy main stdout path from a stalled renderer bridge', () => {
  const h = makeHarness();
  const generation = h.state.noteSpawnStarted('abu-sidecar', true);
  h.state.noteReady('abu-sidecar', generation, 1234);
  h.state.noteStdoutLine('abu-sidecar', JSON.stringify({
    jsonrpc: '2.0',
    method: 'agent.delta',
    params: { runId: 'run-gap', frames: [{ type: 'text' }] },
  }));
  assert.equal(h.state.snapshot().pendingRendererAcks.length, 1);
  h.advance(3_100);
  h.fireTimers();
  assert.equal(h.state.snapshot().pendingRendererAcks.length, 0);
  assert.ok(h.events.some((entry) => entry.event === 'main.renderer_bridge_ack_timeout'));
});

test('renderer first-delta acknowledgement closes the bridge timer and records latency', () => {
  const h = makeHarness();
  const generation = h.state.noteSpawnStarted('abu-sidecar', true);
  h.state.noteReady('abu-sidecar', generation, 1234);
  h.state.noteStdoutLine('abu-sidecar', JSON.stringify({
    jsonrpc: '2.0',
    method: 'agent.delta',
    params: { runId: 'run-ok', frames: [{ type: 'text' }] },
  }));
  h.advance(45);
  assert.equal(h.state.noteRendererEvent({ event: 'renderer.agent_delta_received', runId: 'run-ok' }), true);
  assert.equal(h.timers.size, 0);
  const ack = h.events.find((entry) => entry.event === 'main.renderer_bridge_ack_received');
  assert.equal(ack.attributes.bridgeLatencyMs, 45);
});

test('records renderer resource cleanup without navigation URLs', () => {
  const h = makeHarness();
  h.state.noteRendererResourcesCleared({
    reason: 'main_frame_document_navigation',
    subscriptionCount: 7,
    url: 'file:///private/user/path/index.html',
  });
  assert.deepEqual(h.events.at(-1), {
    processName: 'main',
    event: 'main.renderer_resources_cleared',
    attributes: {
      reason: 'main_frame_document_navigation',
      subscriptionCount: 7,
    },
  });
});

test('records a sidecar bridge miss without payload content', () => {
  const h = makeHarness();
  const generation = h.state.noteSpawnStarted('abu-sidecar', true);
  h.state.noteReady('abu-sidecar', generation, 1234);
  h.state.noteSidecarBridgeDeliveryMissed('message');
  assert.deepEqual(h.events.at(-1), {
    processName: 'main',
    event: 'main.sidecar_bridge_delivery_missed',
    attributes: {
      sidecarId: 'abu-sidecar',
      sidecarGeneration: 1,
      stage: 'message',
      outcome: 'dropped',
      reason: 'no_live_renderer_transport',
    },
  });
});

test('sidecar marker parser accepts only safe sidecar events and attributes', () => {
  const h = makeHarness();
  const generation = h.state.noteSpawnStarted('abu-sidecar', true);
  h.state.noteReady('abu-sidecar', generation, 1234);
  const accepted = h.state.noteSidecarTraceLine('abu-sidecar', `${SIDECAR_TRACE_PREFIX}${JSON.stringify({
    event: 'sidecar.agent_run_started',
    runId: 'run-1',
    prompt: 'private',
    apiKey: 'sk-never-log-this-value',
  })}`);
  assert.equal(accepted, true);
  const event = h.events.find((entry) => entry.event === 'sidecar.agent_run_started');
  assert.equal(event.attributes.runId, 'run-1');
  assert.equal('prompt' in event.attributes, false);
  assert.equal('apiKey' in event.attributes, false);
  assert.equal(h.state.noteSidecarTraceLine('abu-sidecar', `${SIDECAR_TRACE_PREFIX}{bad-json`), false);
});

test('main-process crash observers record without taking over crash behavior', () => {
  const h = makeHarness();
  const crashes = [];
  const processRef = new EventEmitter();
  const dispose = observeMainProcessCrashes(processRef, {
    state: h.state,
    onCrash: (crash) => crashes.push(crash),
  });

  // Electron's own default handler bails out as soon as a SECOND
  // 'uncaughtException' listener exists, which would silently remove its crash
  // dialog. Recording must therefore not add one.
  assert.equal(processRef.listenerCount('uncaughtException'), 0);
  assert.equal(processRef.listenerCount('uncaughtExceptionMonitor'), 1);

  processRef.emit(
    'uncaughtExceptionMonitor',
    Object.assign(new TypeError('boom authorization=Bearer abcdefghijklmnop'), {}),
    'uncaughtException',
  );
  processRef.emit('unhandledRejection', new Error('rejected'), Promise.resolve());

  const uncaught = h.events.find((entry) => entry.event === 'main.uncaught_exception');
  assert.deepEqual(uncaught.attributes, {
    stage: 'uncaught_exception',
    outcome: 'error',
    errorType: 'typeerror',
    reason: 'uncaughtException',
  });
  const rejection = h.events.find((entry) => entry.event === 'main.unhandled_rejection');
  assert.deepEqual(rejection.attributes, {
    stage: 'unhandled_rejection',
    outcome: 'error',
    errorType: 'error',
  });

  assert.equal(crashes.length, 2);
  assert.equal(crashes[0].kind, 'main_uncaught_exception');
  assert.match(crashes[0].message, /\[REDACTED\]/);
  assert.equal(crashes[0].message.includes('abcdefghijklmnop'), false);
  assert.equal(crashes[1].kind, 'main_unhandled_rejection');

  dispose();
  processRef.emit('uncaughtExceptionMonitor', new Error('after dispose'), 'uncaughtException');
  assert.equal(h.events.filter((entry) => entry.event === 'main.uncaught_exception').length, 1);
});

test('a throwing crash consumer cannot escalate the crash it was observing', () => {
  const h = makeHarness();
  const processRef = new EventEmitter();
  observeMainProcessCrashes(processRef, {
    state: h.state,
    onCrash: () => { throw new Error('consumer exploded'); },
  });

  assert.doesNotThrow(() => {
    processRef.emit('uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException');
  });
  assert.ok(h.events.some((entry) => entry.event === 'main.uncaught_exception'));
});

test('renderer death is recorded for every reason but only escalated when severe', () => {
  const h = makeHarness();
  const crashes = [];
  const webContents = new EventEmitter();
  const dispose = observeWebContentsCrashes(webContents, 'main', {
    state: h.state,
    onCrash: (crash) => crashes.push(crash),
  });

  webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 });
  webContents.emit('unresponsive');

  assert.deepEqual(
    h.events.filter((entry) => entry.event === 'main.render_process_gone').map((e) => e.attributes),
    [
      {
        windowLabel: 'main',
        stage: 'render_process_gone',
        outcome: 'error',
        errorType: 'render_process_gone',
        reason: 'clean-exit',
        exitCode: 0,
      },
      {
        windowLabel: 'main',
        stage: 'render_process_gone',
        outcome: 'error',
        errorType: 'render_process_gone',
        reason: 'crashed',
        exitCode: 133,
      },
    ],
  );
  assert.deepEqual(h.events.at(-1), {
    processName: 'main',
    event: 'main.renderer_unresponsive',
    attributes: {
      windowLabel: 'main',
      stage: 'renderer_unresponsive',
      outcome: 'stalled',
      errorType: 'renderer_unresponsive',
    },
  });

  // A clean teardown and a hang are not remote-report material; a death is.
  assert.deepEqual(crashes, [{
    kind: 'renderer_process_gone',
    errorType: 'render_process_gone',
    reason: 'crashed',
    windowLabel: 'main',
    message: '',
  }]);

  dispose();
  webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 9 });
  assert.equal(crashes.length, 1);
});

test('tracks native helper start, readiness, restart, crash, and call timeout without payloads', () => {
  const h = makeHarness();
  h.state.noteNativeHelperSpawnStarted(1, false);
  h.advance(25);
  h.state.noteNativeHelperReady(1, {
    protocol_version: 1,
    binary_version: '0.1.0',
    platform: 'macos',
    secret: 'must not escape',
  });
  h.state.noteNativeHelperCallTimeout(1, 'ax_snapshot', 30_000);
  h.state.noteNativeHelperCrashed(1, 'code=1 sig=null');
  h.state.noteNativeHelperSpawnStarted(2, true);

  assert.ok(h.events.some((entry) => entry.event === 'main.native_helper_ready'));
  assert.ok(h.events.some((entry) => entry.event === 'main.native_helper_call_timeout'));
  assert.ok(h.events.some((entry) => entry.event === 'main.native_helper_crashed'));
  assert.ok(h.events.some((entry) => entry.event === 'main.native_helper_restarted'));
  const ready = h.events.find((entry) => entry.event === 'main.native_helper_ready');
  assert.equal(ready.attributes.helperGeneration, 1);
  assert.equal(ready.attributes.helperProtocolVersion, 1);
  assert.equal(ready.attributes.helperBinaryVersion, '0.1.0');
  assert.equal('secret' in ready.attributes, false);
  assert.deepEqual(h.state.snapshot().nativeHelpers, [
    { helperGeneration: 1, stage: 'crashed', durationMs: 25 },
    { helperGeneration: 2, stage: 'starting', durationMs: 0 },
  ]);
});
