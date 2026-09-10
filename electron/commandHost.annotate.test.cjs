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

/**
 * Real seatbelt/zsh stderr, captured firsthand on this machine (macOS 15,
 * `sandbox-exec` + `/bin/zsh -lc`, the same shell shape `commandHost.cjs`
 * uses). Recorded here because zsh emits ONE sentence for two different
 * denials, which is exactly what the classifier has to tell apart:
 *
 *   $ sandbox-exec -p '(version 1)(allow default)
 *       (deny file-write* (subpath "/private/tmp/sbxtest"))' \
 *       /bin/zsh -lc 'echo x > /private/tmp/sbxtest/f'
 *   zsh:1: operation not permitted: /private/tmp/sbxtest/f      # a WRITE
 *
 *   $ sandbox-exec -p '(version 1)(allow default)
 *       (deny process-exec* (literal "/bin/ps"))' \
 *       /bin/zsh -lc 'ps aux'
 *   zsh:1: operation not permitted: ps                          # an EXEC
 *
 *   $ sandbox-exec -p '(version 1)(allow default)
 *       (deny file-write* (subpath "/private/tmp/sbxtest"))' \
 *       /bin/zsh -lc 'cp /etc/hosts /private/tmp/sbxtest/h'
 *   cp: /private/tmp/sbxtest/h: Operation not permitted         # a WRITE
 *
 * And the EACCES-shaped variants (chmod 555 dir, no sandbox needed):
 *   zsh:1: permission denied: /private/tmp/sbxro/f              # a WRITE
 *   cp: /private/tmp/sbxro/h: Permission denied                 # a WRITE
 *   zsh:1: permission denied: /private/tmp/sbxro                # an EXEC
 */

test('real zsh stderr: a denied redirect target is a write, not an exec', () => {
  const line = reasonLine(
    'zsh:1: operation not permitted: /private/tmp/sbxtest/f',
    'echo x > /private/tmp/sbxtest/f',
  );
  assert.match(line, /file write blocked/);
  assert.ok(!line.includes('(exec)'), line);
});

test('real zsh stderr: a denied exec keeps the exec class', () => {
  const line = reasonLine('zsh:1: operation not permitted: ps', 'ps aux');
  assert.match(line, /\(exec\)/);
  assert.ok(!line.includes('file write'), line);
});

test('real cp stderr: a denied copy target is a write', () => {
  const line = reasonLine(
    'cp: /private/tmp/sbxtest/h: Operation not permitted',
    'cp /etc/hosts /private/tmp/sbxtest/h',
  );
  assert.match(line, /file write blocked/);
  assert.ok(!line.includes('(exec)'), line);
});

test('a redirect target with no space after ">" is still a write', () => {
  const line = reasonLine(
    'zsh:1: operation not permitted: /private/tmp/sbxtest/f',
    'echo x >/private/tmp/sbxtest/f',
  );
  assert.match(line, /file write blocked/);
});

test('real EACCES stderr: "permission denied" on a redirect target is a write', () => {
  const line = reasonLine(
    'zsh:1: permission denied: /private/tmp/sbxro/f',
    'echo x > /private/tmp/sbxro/f',
  );
  assert.match(line, /file write blocked/);
});

test('real EACCES stderr: "Permission denied" from cp is a write', () => {
  const line = reasonLine(
    'cp: /private/tmp/sbxro/h: Permission denied',
    'cp /etc/hosts /private/tmp/sbxro/h',
  );
  assert.match(line, /file write blocked/);
});

test('real EACCES stderr: a denied exec stays unattributed, not a write', () => {
  const line = reasonLine('zsh:1: permission denied: /private/tmp/sbxro', '/private/tmp/sbxro');
  assert.match(line, /access denied — possibly blocked/);
  assert.ok(!line.includes('file write'), line);
});

test('a denied `cp` binary is an exec, not its own write target', () => {
  const line = reasonLine('zsh:1: operation not permitted: cp', 'cp a b');
  assert.match(line, /\(exec\)/);
  assert.ok(!line.includes('file write'), line);
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
