'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSidecarRunRegistry } = require('./sidecarRunRegistry.cjs');

test('mirrors start, running, and terminal run facts without retaining prompts', () => {
  let clock = 100;
  const registry = createSidecarRunRegistry({ now: () => clock });
  assert.equal(registry.beginGeneration(), 1);
  registry.markReady();
  registry.observeOutbound(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'agent.start', params: {
      runId: 'run-1', clientMessageId: 'message-1', payloadDigest: 'digest-1', userMessage: 'private',
    },
  }));
  registry.observeInbound(JSON.stringify({
    jsonrpc: '2.0', id: 1, result: {
      state: 'accepted', runId: 'run-1', clientMessageId: 'message-1', acceptedAt: 90,
    },
  }));
  registry.observeOutbound(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'agent.run', params: { runId: 'run-1' } }));
  clock = 200;
  const terminal = { version: 1, runId: 'run-1', state: 'completed', result: { reason: 'completed' } };
  registry.observeInbound(JSON.stringify({ jsonrpc: '2.0', method: 'agent.terminal', params: terminal }));

  const [run] = registry.snapshot().runs;
  assert.equal(run.state, 'terminal');
  assert.deepEqual(run.terminal, terminal);
  assert.equal(run.clientMessageId, 'message-1');
  assert.equal(JSON.stringify(run).includes('private'), false);
});

test('assigns monotonic sequences and reports an unrecoverable buffer gap', () => {
  const registry = createSidecarRunRegistry({ maxEvents: 2 });
  registry.beginGeneration();
  assert.equal(registry.recordEvent('message', 'one').sequence, 1);
  assert.equal(registry.recordEvent('message', 'two').sequence, 2);
  assert.equal(registry.recordEvent('close', '').sequence, 3);

  assert.deepEqual(registry.snapshot(1).events.map((event) => event.sequence), [2, 3]);
  assert.equal(registry.snapshot(0).truncated, true);
  assert.equal(registry.snapshot(1).truncated, false);
});

test('preserves terminal facts across sidecar process generations', () => {
  const registry = createSidecarRunRegistry();
  registry.beginGeneration();
  registry.observeOutbound(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent.start', params: {
    runId: 'run-old', clientMessageId: 'message-old', payloadDigest: 'digest-old',
  } }));
  registry.observeInbound(JSON.stringify({ jsonrpc: '2.0', method: 'agent.terminal', params: {
    version: 1, runId: 'run-old', state: 'failed', result: { reason: 'error' },
  } }));
  registry.beginGeneration();

  const snapshot = registry.snapshot();
  assert.equal(snapshot.generation, 2);
  assert.equal(snapshot.runs[0].state, 'terminal');
});

test('bounds replay memory by payload size and exposes the resulting gap', () => {
  const registry = createSidecarRunRegistry({ maxEvents: 10, maxEventChars: 5 });
  registry.beginGeneration();
  registry.recordEvent('message', '1234');
  registry.recordEvent('message', '5678');

  const snapshot = registry.snapshot(0);
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.events.map((event) => event.payload), ['5678']);
  assert.equal(snapshot.firstAvailableSequence, 2);
});

test('reports a sequence hole when one oversized frame is omitted between retained events', () => {
  const registry = createSidecarRunRegistry({ maxEvents: 10, maxEventChars: 10 });
  registry.beginGeneration();
  registry.recordEvent('message', 'one');
  registry.recordEvent('message', '01234567890');
  registry.recordEvent('message', 'three');

  const snapshot = registry.snapshot(1);
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.events.map((event) => event.sequence), [3]);
});

test('keeps the first terminal fact when a conflicting terminal arrives later', () => {
  const registry = createSidecarRunRegistry();
  registry.beginGeneration();
  const completed = { version: 1, runId: 'run-1', state: 'completed', result: { reason: 'completed' } };
  const failed = { version: 1, runId: 'run-1', state: 'failed', result: { reason: 'error' } };
  registry.observeInbound(JSON.stringify({ jsonrpc: '2.0', method: 'agent.terminal', params: completed }));
  registry.observeInbound(JSON.stringify({ jsonrpc: '2.0', method: 'agent.terminal', params: failed }));

  assert.deepEqual(registry.snapshot().runs[0].terminal, completed);
});

test('bounds non-terminal run facts by evicting the oldest mirror entry', () => {
  let clock = 0;
  const registry = createSidecarRunRegistry({ maxRuns: 2, now: () => ++clock });
  registry.beginGeneration();
  for (let index = 1; index <= 5; index++) {
    registry.observeOutbound(JSON.stringify({
      jsonrpc: '2.0', id: index, method: 'agent.start', params: {
        runId: `run-${index}`, clientMessageId: `message-${index}`, payloadDigest: `digest-${index}`,
      },
    }));
  }

  assert.deepEqual(registry.snapshot().runs.map((run) => run.runId), ['run-4', 'run-5']);
});

test('ignores an incomplete terminal state until the immutable terminal fact arrives', () => {
  const registry = createSidecarRunRegistry();
  registry.beginGeneration();
  registry.observeOutbound(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'run.getState', params: { runId: 'run-1' },
  }));
  registry.observeInbound(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { state: 'terminal' } }));
  const terminal = { version: 1, runId: 'run-1', state: 'completed', result: { reason: 'completed' } };
  registry.observeInbound(JSON.stringify({ jsonrpc: '2.0', method: 'agent.terminal', params: terminal }));

  assert.deepEqual(registry.snapshot().runs[0].terminal, terminal);
});
