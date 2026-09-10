'use strict';

/**
 * Unit tests for `annotateSandboxViolations` — the sandbox-violation
 * classifier that prefixes `[sandbox-blocked] <reasons>` onto stderr.
 *
 * Regression driver: a read-only `ps` denied by the seatbelt profile
 * (setuid binary => exec failure) was reported as "file write or network
 * access blocked", which drove a misleading "write blocked" toast. Exec
 * failures are now their own class and the fallback no longer asserts a
 * class it cannot prove.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { annotateSandboxViolations } = require('./commandHost.cjs');

/** First line of the annotated stderr (the `[sandbox-blocked] ...` reasons). */
function reasonLine(stderr, command) {
  return annotateSandboxViolations(stderr, command, true).split('\n')[0];
}

test('zsh exec denial (setuid binary) is classified as exec, not write', () => {
  const line = reasonLine('zsh:1: operation not permitted: ps', 'ps aux');
  assert.match(line, /\(exec\)/);
  assert.ok(!line.includes('file write'), line);
});

test('bash exec denial on an absolute path is classified as exec, not write', () => {
  const line = reasonLine('bash: /usr/bin/ps: Operation not permitted', 'ps');
  assert.match(line, /\(exec\)/);
  assert.ok(!line.includes('file write'), line);
});

test('EACCES on a listening socket is not reported as a file write', () => {
  const line = reasonLine('listen EACCES: permission denied 0.0.0.0:3000', 'node server.js');
  assert.ok(!line.includes('file write'), line);
  assert.match(line, /access denied — possibly blocked/);
});

test('a redirect into a protected path is classified as a file write', () => {
  const line = reasonLine('operation not permitted', 'echo x > /etc/hosts');
  assert.match(line, /file write blocked/);
});

test('"cannot create" is classified as a file write even with a shell prefix', () => {
  const line = reasonLine('sh: cannot create /x: operation not permitted', 'sh -c "..."');
  assert.match(line, /file write blocked/);
});

test('DNS failures stay classified as network', () => {
  const line = reasonLine('curl: (6) Could not resolve host', 'curl a');
  assert.match(line, /network/);
});

test('an unattributable denial falls back to unclassified, asserting nothing', () => {
  const line = reasonLine('operation not permitted', 'weird-tool');
  assert.match(line, /\(unclassified\)/);
  assert.ok(!line.includes('file write'), line);
});

test('the [sandbox-blocked] prefix is kept regardless of the class', () => {
  const annotated = annotateSandboxViolations('zsh:1: operation not permitted: ps', 'ps aux', true);
  assert.ok(annotated.startsWith('[sandbox-blocked] '), annotated);
  assert.ok(annotated.includes('zsh:1: operation not permitted: ps'), annotated);
});

test('nothing is annotated when the sandbox is off', () => {
  assert.equal(annotateSandboxViolations('operation not permitted', 'ps', false), 'operation not permitted');
});
