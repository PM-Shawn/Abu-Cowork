'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { createOwnedChildProcesses } = require('./ownedChildProcesses.cjs');

test('exit waits for real child close, including a generation already signalled', async () => {
  const owner = createOwnedChildProcesses();
  const children = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'pipe', windowsHide: true }));
  const closed = new Set();
  for (const child of children) {
    owner.track(child, () => { if (!child.killed) child.kill('SIGKILL'); });
    child.once('close', () => closed.add(child));
  }
  await Promise.all(children.map(child => once(child, 'spawn')));
  children[0].kill('SIGKILL');
  await owner.shutdown();
  assert.equal(closed.size, 2);
  for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('exit closes process admission and cancellation restores it', async () => {
  const owner = createOwnedChildProcesses();
  owner.assertAdmission();
  const closing = owner.shutdown();
  assert.throws(() => owner.assertAdmission(), /Application is exiting/);
  await closing;
  owner.resume();
  owner.assertAdmission();
});

test('a child that does not close rejects with its identity and can be retried', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = createOwnedChildProcesses({ timeoutMs: 100 });
  let finish;
  let stops = 0;
  owner.trackCompletion(new Promise(resolve => { finish = resolve; }), () => { stops++; }, 'terminal 123');
  const failed = assert.rejects(owner.shutdown(), /ABU_EXIT_CHILD_TIMEOUT: terminal 123/);
  context.mock.timers.tick(100);
  await failed;
  owner.resume();
  owner.assertAdmission();
  const retried = owner.shutdown();
  finish();
  await retried;
  assert.equal(stops, 2);
});
