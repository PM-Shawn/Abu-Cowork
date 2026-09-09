'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAlive } = require('./pluginLease.cjs');

const withKill = (impl, run) => {
  const original = process.kill;
  process.kill = impl;
  try { run(); } finally { process.kill = original; }
};
const throwing = code => () => { throw Object.assign(new Error(code), { code }); };

/**
 * Regression: a crashed app leaves `owner-<pid>-<token>` behind. Treating EPERM
 * as "still running" meant a recycled PID owned by another user locked the
 * profile across restarts, with no way out from the UI.
 */
test('a lease owner PID that no longer belongs to us is stale, not alive', () => {
  withKill(throwing('ESRCH'), () => assert.equal(isAlive(4242), false));
  withKill(throwing('EPERM'), () => assert.equal(isAlive(4242), false));
});

test('an unknown errno stays conservative so a live lease is never stolen', () => {
  withKill(() => true, () => assert.equal(isAlive(4242), true));
  withKill(throwing('EINVAL'), () => assert.equal(isAlive(4242), true));
});
