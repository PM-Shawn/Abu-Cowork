'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  registerRendererCallbackContext,
  captureRendererCallbackOwner,
  forgetRendererCallbackContext,
  assertCurrentRendererCallbackOwner,
} = require('./rendererCallbackContext.cjs');
const { sendChannelMessage } = require('./channelBridge.cjs');

test('a suspended operation retains its creation context after a document replacement', async () => {
  const sender = { isDestroyed: () => false, send() {} };
  registerRendererCallbackContext(sender, 'first');
  const owner = captureRendererCallbackOwner(sender, 'first');
  let resume;
  const suspended = new Promise(resolve => { resume = resolve; });
  const operation = suspended.then(() => assertCurrentRendererCallbackOwner(owner));
  registerRendererCallbackContext(sender, 'second');
  resume();
  await assert.rejects(operation, /no longer active/);
  assert.throws(() => captureRendererCallbackOwner(sender, 'first'), /no longer active/);
  assert.doesNotThrow(() => captureRendererCallbackOwner(sender, 'second'));
});

test('Channel delivery remains bound to its document and its own window', () => {
  const sent = [];
  let destroyed = false;
  const sender = { isDestroyed: () => destroyed, send: (channel, payload) => sent.push({ channel, payload }) };
  const other = { isDestroyed: () => false, send: () => assert.fail('wrong window') };
  registerRendererCallbackContext(sender, 'first');
  registerRendererCallbackContext(other, 'other');
  const old = captureRendererCallbackOwner(sender, 'first');
  registerRendererCallbackContext(other, 'other-next');
  assert.equal(sendChannelMessage(old, 1, 0, 'first-message'), true);
  registerRendererCallbackContext(sender, 'second');
  assert.equal(sendChannelMessage(old, 1, 1, 'stale-message'), false);
  const current = captureRendererCallbackOwner(sender, 'second');
  assert.equal(sendChannelMessage(current, 1, 0, 'second-message'), true);
  assert.deepEqual(sent.map(entry => [entry.payload.contextId, entry.payload.payload.message]), [
    ['first', 'first-message'], ['second', 'second-message'],
  ]);
  destroyed = true;
  assert.equal(sendChannelMessage(current, 1, 1, 'destroyed-message'), false);
  destroyed = false;
  forgetRendererCallbackContext(sender);
  assert.equal(sendChannelMessage(current, 1, 1, 'retired-message'), false);
});

function loadPreload(file, options = {}) {
  const { contextId = 'current-context' } = options;
  const acknowledgement = Object.hasOwn(options, 'acknowledgement') ? options.acknowledgement : { ok: true, contextId };
  const exposed = options.exposed ?? new Map();
  const listeners = new Map();
  const invokes = [];
  const context = {
    process: { contextId, argv: [] },
    require(id) {
      assert.equal(id, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
        ipcRenderer: {
          on: (name, listener) => listeners.set(name, listener),
          send() {},
          sendSync(channel, requestedContext) {
            if (channel === 'tauri:callback-context') {
              assert.equal(requestedContext, contextId);
              return acknowledgement;
            }
            return null;
          },
          async invoke(channel, payload, ownerContext) {
            invokes.push({ channel, payload, ownerContext });
            return 1;
          },
        },
        webUtils: { getPathForFile: () => '' },
      };
    },
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
  return { exposed, listeners, invokes };
}

async function registerCallback(bridge, file, callback) {
  if (file === 'preload.cjs') {
    return bridge.exposed.get('__TAURI_INTERNALS__').transformCallback(callback);
  }
  await bridge.exposed.get('__TAURI__').event.listen('computer-use-status', callback);
  return bridge.invokes[0].payload.args.handler;
}

for (const file of ['preload.cjs', 'guiTauriGlobalPreload.cjs']) {
  test(`${file}: an old context cannot deliver to a reused callback number`, async () => {
    const bridge = loadPreload(file);
    const received = [];
    const id = await registerCallback(bridge, file, payload => received.push(payload));
    bridge.listeners.get('tauri:callback')({}, { id, contextId: 'previous-context', payload: 'old message' });
    assert.deepEqual(received, []);
    bridge.listeners.get('tauri:callback')({}, { id, contextId: 'current-context', payload: 'current message' });
    assert.deepEqual(received, ['current message']);
  });

  test(`${file}: an old uncallback cannot remove the current callback`, async () => {
    const bridge = loadPreload(file);
    const received = [];
    const id = await registerCallback(bridge, file, payload => received.push(payload));
    bridge.listeners.get('tauri:uncallback')({}, { id, contextId: 'previous-context' });
    bridge.listeners.get('tauri:callback')({}, { id, contextId: 'current-context', payload: 'still registered' });
    assert.deepEqual(received, ['still registered']);
    bridge.listeners.get('tauri:uncallback')({}, { id, contextId: 'current-context' });
    bridge.listeners.get('tauri:callback')({}, { id, contextId: 'current-context', payload: 'removed' });
    assert.deepEqual(received, ['still registered']);
  });

  test(`${file}: invoke carries the private creation context outside the business payload`, async () => {
    const bridge = loadPreload(file);
    if (file === 'preload.cjs') {
      await bridge.exposed.get('__TAURI_INTERNALS__').invoke('get_trigger_server_port', {});
    } else {
      await bridge.exposed.get('__TAURI__').event.emit('computer-use-abort', {});
    }
    assert.equal(bridge.invokes[0].ownerContext, 'current-context');
    assert.equal(Object.hasOwn(bridge.invokes[0].payload, 'contextId'), false);
  });

  test(`${file}: a refused registration cannot expose page APIs`, () => {
    const exposed = new Map();
    assert.throws(() => loadPreload(file, {
      acknowledgement: { ok: false, error: 'context registration refused' },
      exposed,
    }), /callback context/i);
    assert.equal(exposed.size, 0);
  });

  for (const [label, acknowledgement] of [
    ['missing', undefined], ['null', null], ['mismatched', { ok: true, contextId: 'other-context' }],
  ]) {
    test(`${file}: ${label} acknowledgement prevents page API exposure`, () => {
      const exposed = new Map();
      assert.throws(() => loadPreload(file, { acknowledgement, exposed }), /callback context/i);
      assert.equal(exposed.size, 0);
    });
  }

  test(`${file}: a missing native context identity fails initialization`, () => {
    assert.throws(() => loadPreload(file, { contextId: '' }), /context/i);
  });
}
