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

/**
 * Multi-segment commands. The subject in a denial sentence comes from ONE
 * simple command, so the write-target rules are evaluated per segment: a
 * `mkdir`/`cp` on an earlier line must not claim a denial raised by a later
 * one. All four stderr strings below are the same real `ps` exec denial.
 */

test('a write command on an earlier line does not swallow a later exec denial', () => {
  const line = reasonLine('zsh:1: operation not permitted: ps', 'mkdir -p /tmp/out\nps aux > /tmp/out/p.txt');
  assert.match(line, /\(exec\)/);
  assert.ok(!line.includes('file write'), line);
});

test('a cp on an earlier line does not swallow a later exec denial', () => {
  const line = reasonLine('zsh:1: operation not permitted: ps', 'cp a b\nps aux');
  assert.match(line, /\(exec\)/);
  assert.ok(!line.includes('file write'), line);
});

test('a write command word used as an argument (grep cp) is not a copy', () => {
  const line = reasonLine('zsh:1: operation not permitted: ps', 'grep cp notes.txt\nps aux');
  assert.match(line, /\(exec\)/);
  assert.ok(!line.includes('file write'), line);
});

test('a redirect target that merely starts with the subject is not a match', () => {
  const line = reasonLine('zsh:1: operation not permitted: ps', 'cat /etc/hosts >psout.txt\nps aux');
  assert.match(line, /\(exec\)/);
  assert.ok(!line.includes('file write'), line);
});

test('a write on a later line is still a write', () => {
  const line = reasonLine(
    'zsh:1: operation not permitted: /tmp/out/f',
    'mkdir -p /tmp/out\necho x > /tmp/out/f',
  );
  assert.match(line, /file write blocked/);
  assert.ok(!line.includes('(exec)'), line);
});

/**
 * A quoted redirect target containing spaces is reported truncated at the
 * first space (the denial sentence is captured with `\S+`), so the subject is
 * `/tmp/my` for target `/tmp/my dir/f`. Matching the target's first chunk is
 * what accepts this without letting `ps` match `psout.txt` above.
 */
test('a quoted redirect target with spaces is still a write', () => {
  const line = reasonLine('zsh:1: operation not permitted: /tmp/my', 'echo x > "/tmp/my dir/f"');
  assert.match(line, /file write blocked/);
  assert.ok(!line.includes('(exec)'), line);
});

/**
 * cp/mv write only their LAST argument; the others are sources they read. A
 * denial naming a source is therefore a read denial, not a write — and must
 * not raise the "authorize this directory" toast, whose path would point at
 * the unrelated destination.
 */

test('an EACCES on a cp SOURCE is not a write', () => {
  const line = reasonLine('zsh:1: permission denied: /tmp/ro/src', 'cp /tmp/ro/src /tmp/dst');
  assert.match(line, /access denied — possibly blocked/);
  assert.ok(!line.includes('file write'), line);
});

test('a "Permission denied" from cp naming its SOURCE is not a write', () => {
  const line = reasonLine('cp: /tmp/ro/src: Permission denied', 'cp /tmp/ro/src /tmp/dst');
  assert.match(line, /access denied — possibly blocked/);
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
