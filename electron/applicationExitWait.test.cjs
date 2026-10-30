'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createApplicationExitWait } = require('./applicationExitWait.cjs');

test('a restart that neither quits nor emits an error restores the application on its deadline', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const app = new EventEmitter();
  let restored = 0;
  const request = createApplicationExitWait(app, () => { restored++; }, 100);
  const rejected = assert.rejects(request.wait, /restart did not complete/);
  context.mock.timers.tick(100);
  await rejected;
  assert.equal(restored, 1);
  assert.equal(app.listenerCount('will-quit'), 0);
  request.fail();
  assert.equal(restored, 1);
});

test('a real quit removes the deadline and preserves exit preparation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const app = new EventEmitter();
  let restored = 0;
  const request = createApplicationExitWait(app, () => { restored++; }, 100);
  app.emit('will-quit');
  await request.wait;
  context.mock.timers.tick(100);
  assert.equal(restored, 0);
});

test('an update error cancels the current wait without affecting a later retry', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const app = new EventEmitter();
  let restored = 0;
  const first = createApplicationExitWait(app, () => { restored++; }, 100);
  const rejected = assert.rejects(first.wait, /restart did not complete/);
  first.fail();
  await rejected;
  const retry = createApplicationExitWait(app, () => { restored++; }, 200);
  context.mock.timers.tick(100);
  assert.equal(restored, 1);
  app.emit('will-quit');
  await retry.wait;
});

test('the installation error reaches the restart caller', async () => {
  const app = new EventEmitter();
  const request = createApplicationExitWait(app, () => {});
  const failure = new Error('installation permission denied');
  const rejected = assert.rejects(request.wait, error => error === failure);
  request.fail(failure);
  await rejected;
});
