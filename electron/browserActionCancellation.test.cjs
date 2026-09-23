'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runCancellableAction } = require('./browserActionCancellation.cjs');
test('abort sends cancellation into the same world and still awaits native completion', async () => {
  const controller = new AbortController(); const calls = []; let finish;
  const native = new Promise(resolve => { finish = resolve; });
  let settled = false;
  const running = runCancellableAction({ action: 'wait_for', payload: {}, referenceBase: 1000000,
    signal: controller.signal, dispatch: (code, current) => { calls.push({code,current}); return current ? native : Promise.resolve(); },
  }).then(() => { settled = true; });
  controller.abort(); await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(calls.length, 2);
  assert.match(calls[1].code, /cancelAction/);
  assert.match(calls[1].code, /referenceBase === 1000000/);
  assert.equal(calls[1].current, false);
  finish(); await running;
});
test('already cancelled work never enters the renderer', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(runCancellableAction({action: 'click', payload: {}, referenceBase: 1,
    signal: controller.signal, dispatch: () => { calls++; },}), /cancelled/);
  assert.equal(calls, 0);
});
