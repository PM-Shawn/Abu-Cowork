'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, afterEach } = require('node:test');
const { commandDispatch, __resetCommandHostForTests } = require('./commandHost.cjs');

const app = { isPackaged: false, once() {} };
const windowsOnly = { skip: process.platform !== 'win32' };
const testRoot = path.resolve(__dirname, '..', '.agent', 'windows-sandbox-tests');

function runSandboxed(command) {
  return commandDispatch(app, 'run_shell_command', {
    command,
    background: false,
    timeout: 30,
    sandboxEnabled: true,
  });
}

before(async () => {
  if (process.platform !== 'win32') return;
  const host = await commandDispatch(app, 'run_shell_command', {
    command: 'whoami.exe /groups /fo csv /nh',
    background: false,
    timeout: 30,
    sandboxEnabled: false,
  });
  assert.equal(host.code, 0, host.stderr);
  const level = /S-1-16-\d+/.exec(host.stdout)?.[0];
  assert.ok(level, 'host token must report its integrity level');
  console.log(`[windows-sandbox] host integrity level SID: ${level}`);
});

afterEach(() => {
  __resetCommandHostForTests();
});

test('sandboxed PowerShell starts a native exe that inherits its output', windowsOnly, async () => {
  const result = await runSandboxed('cmd.exe /c ver');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Windows/);
});

test('sandboxed PowerShell pipes a native exe into a cmdlet', windowsOnly, async () => {
  const result = await runSandboxed('whoami.exe | Select-Object -First 1');
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /NativeCommandFailed/);
  assert.notEqual(result.stdout.trim(), '');
});

test('sandboxed PowerShell pipes the bundled Python into a cmdlet', windowsOnly, async () => {
  const result = await runSandboxed('python --version | Select-Object -First 1');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Python 3\./);
});

test('sandboxed PowerShell merges native stderr into the pipeline', windowsOnly, async () => {
  const result = await runSandboxed(
    'cmd.exe /c "echo out& echo err 1>&2" 2>&1 | ForEach-Object { "$_" }; exit $LASTEXITCODE',
  );
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /NativeCommandFailed/);
  assert.match(result.stdout, /out/);
  assert.match(result.stdout, /err/);
});

test('a sandboxed cmd.exe pipes one native exe into another', windowsOnly, async () => {
  const result = await runSandboxed('cmd.exe /c "whoami | findstr /r ."');
  assert.equal(result.code, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), '');
});

test('sandboxed PowerShell starts a native exe in a new hidden console', windowsOnly, async (t) => {
  fs.mkdirSync(testRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(testRoot, 'hidden-console-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'started.txt');
  const argument = `/c echo started> "${marker}"`.replace(/'/g, "''");
  const result = await runSandboxed(
    `Start-Process -FilePath cmd.exe -ArgumentList '${argument}' -WindowStyle Hidden -Wait`,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(fs.readFileSync(marker, 'utf8'), /started/);
});

test('a sandboxed process reads its own token', windowsOnly, async () => {
  const result = await runSandboxed('whoami.exe /groups /fo csv /nh');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /S-1-5-/);
});

test('the sandboxed token keeps only the change-notify privilege', windowsOnly, async () => {
  const result = await runSandboxed('whoami.exe /priv');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /SeChangeNotifyPrivilege/);
  assert.doesNotMatch(result.stdout, /Se(?!ChangeNotify)\w+Privilege/);
});

test('run_argv_command starts a sandboxed exe whose child pipes into another', windowsOnly, async () => {
  const result = await commandDispatch(app, 'run_argv_command', {
    program: 'cmd.exe',
    args: ['/c', 'whoami | findstr /r .'],
    timeout: 30,
    sandboxEnabled: true,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), '');
});
