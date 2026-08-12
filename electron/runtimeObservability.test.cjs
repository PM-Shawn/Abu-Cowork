'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  SIDECAR_TRACE_PREFIX,
  createRuntimeState,
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
