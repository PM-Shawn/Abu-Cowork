'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('preload restores interaction on cancellation and isolates a late callback from the retry', async () => {
  const handlers = new Map();
  const exposed = new Map();
  const invoked = [];
  const context = {
    process: { contextId: 'quit-test', argv: [] },
    document: { body: { inert: false } },
    require(id) {
      assert.equal(id, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, value) => exposed.set(key, value) },
        ipcRenderer: {
          on: (channel, handler) => handlers.set(channel, handler),
          sendSync: (channel, contextId) => channel === 'tauri:callback-context' ? { ok: true, contextId } : null,
          invoke: async (channel, payload) => { invoked.push({ channel, payload }); return true; },
        },
        webUtils: {},
      };
    },
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), context);
  const operations = [];
  let cancellations = 0;
  let releases = 0;
  await exposed.get('__ABU_SHELL__').registerQuitParticipant(onCancel => {
    onCancel(() => { cancellations++; });
    return new Promise(resolve => operations.push(() => resolve(() => { releases++; })));
  }, 'Unable to save. Please retry.');
  const old = handlers.get('abu:quit-prepare')({}, 'old');
  assert.equal(context.document.body.inert, true);
  handlers.get('abu:quit-cancel')({}, 'old');
  assert.equal(context.document.body.inert, false);
  assert.equal(cancellations, 1);
  const retry = handlers.get('abu:quit-prepare')({}, 'retry');
  assert.equal(context.document.body.inert, true);
  operations[0]();
  await old;
  assert.equal(context.document.body.inert, true);
  assert.equal(invoked.some(call => call.channel === 'abu:quit-ack' && call.payload.id === 'old'), false);
  operations[1]();
  await retry;
  assert.equal(context.document.body.inert, true);
  handlers.get('abu:quit-cancel')({}, 'retry');
  assert.equal(context.document.body.inert, false);
  assert.equal(releases, 2);
});

test('a failed save stays frozen and retry acquires its barrier before releasing the previous one', async () => {
  const handlers = new Map();
  const exposed = new Map();
  const order = [];
  const context = {
    process: { contextId: 'quit-test', argv: [] },
    document: { body: { inert: false } },
    require() {
      return {
        contextBridge: { exposeInMainWorld: (key, value) => exposed.set(key, value) },
        ipcRenderer: {
          on: (channel, handler) => handlers.set(channel, handler),
          sendSync: (channel, contextId) => channel === 'tauri:callback-context' ? { ok: true, contextId } : null,
          invoke: async () => true,
        },
        webUtils: {},
      };
    },
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), context);
  let attempts = 0;
  await exposed.get('__ABU_SHELL__').registerQuitParticipant(async onCancel => {
    const attempt = ++attempts;
    order.push(`acquire-${attempt}`);
    onCancel(() => { order.push(`cancel-${attempt}`); });
    if (attempt === 1) throw new Error('disk full');
    return () => {};
  }, 'Unable to save');
  await handlers.get('abu:quit-prepare')({}, 'failed');
  assert.equal(context.document.body.inert, true);
  assert.deepEqual(order, ['acquire-1']);
  await handlers.get('abu:quit-prepare')({}, 'retry');
  assert.deepEqual(order, ['acquire-1', 'acquire-2', 'cancel-1']);
  handlers.get('abu:quit-cancel')({}, 'retry');
  assert.equal(context.document.body.inert, false);
});
