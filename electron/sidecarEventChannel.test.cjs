'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  SIDECAR_BRIDGE_STATE_CHANNEL,
  SIDECAR_EVENT_CHANNEL,
  sendDedicatedSidecarEvent,
  toDedicatedSidecarEvent,
} = require('./sidecarEventChannel.cjs');

test('claims only the fixed Abu sidecar event family', () => {
  assert.equal(SIDECAR_BRIDGE_STATE_CHANNEL, 'abu:sidecar-bridge-state');
  assert.deepEqual(toDedicatedSidecarEvent('mcp-msg-abu-sidecar', '{"ok":true}'), {
    type: 'message',
    payload: '{"ok":true}',
  });
  assert.deepEqual(toDedicatedSidecarEvent('mcp-err-abu-sidecar', 'failure'), {
    type: 'error',
    payload: 'failure',
  });
  assert.deepEqual(toDedicatedSidecarEvent('mcp-close-abu-sidecar', ''), {
    type: 'close',
    payload: '',
  });
  assert.deepEqual(toDedicatedSidecarEvent('mcp-hung-abu-sidecar', ''), {
    type: 'hung',
    payload: '',
  });
  assert.equal(toDedicatedSidecarEvent('mcp-msg-third-party-server', 'x'), null);
  assert.equal(toDedicatedSidecarEvent('tauri://focus', null), null);
});

test('sends only to a live renderer WebContents', () => {
  const sent = [];
  const live = {
    isDestroyed: () => false,
    send: (...args) => sent.push(args),
  };
  const event = { type: 'close', payload: '', sequence: 7, generation: 2 };
  assert.equal(sendDedicatedSidecarEvent(live, event), true);
  assert.deepEqual(sent, [[SIDECAR_EVENT_CHANNEL, event]]);

  assert.equal(sendDedicatedSidecarEvent({
    isDestroyed: () => true,
    send: () => assert.fail('destroyed renderer must not receive an event'),
  }, { type: 'hung', payload: '' }), false);
  assert.equal(sendDedicatedSidecarEvent({
    isDestroyed: () => false,
    send: () => { throw new Error('renderer disappeared'); },
  }, { type: 'close', payload: '' }), false);
  assert.equal(sendDedicatedSidecarEvent(null, { type: 'hung', payload: '' }), false);
});
