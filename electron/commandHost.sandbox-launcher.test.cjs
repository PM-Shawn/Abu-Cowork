'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');

const {
  commandDispatch,
  teardownCommandHost,
  buildSandboxedCommandSpec,
  buildSandboxedArgvCommandSpec,
  makeLauncherConfig,
  generateSeatbeltProfile,
  __resetCommandHostForTests,
} = require('./commandHost.cjs');

const app = { isPackaged: false, once() {} };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'abu-command-host-'));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function readPid(pidFile, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await wait(50);
  }
  throw new Error(`pid file was not written: ${pidFile}`);
}

function grandchildCommand(pidFile, readyFile) {
  const script = `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
      setInterval(() => {}, 1000);
    `;
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

function detachedGrandchildCommand(pidFile) {
  const script = `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        detached: true,
      });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

function orphanedSameGroupChildCommand(pidFile) {
  const script = `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      child.unref();
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    `;
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

async function waitForDead(pid, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    if (!pidAlive(pid)) return;
    await wait(100);
  }
  assert.equal(pidAlive(pid), false, `pid ${pid} should be dead`);
}

afterEach(() => {
  __resetCommandHostForTests();
});

test('run_shell_command executes ordinary shell commands through launcher', async () => {
  const result = await commandDispatch(app, 'run_shell_command', {
    command: 'printf hello',
    background: false,
    timeout: 5,
    sandboxEnabled: false,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hello');
});

test('run_argv_command preserves argv literally and does not pass through a shell', async () => {
  const marker = 'argv;touch /tmp/abu-should-not-exist';
  const result = await commandDispatch(app, 'run_argv_command', {
    program: process.execPath,
    args: ['-e', 'console.log(process.argv[1])', marker],
    timeout: 5,
    sandboxEnabled: false,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /argv;touch/);
});

test('foreground timeout kills the descendant process tree', async () => {
  if (process.platform === 'win32') return;
  const dir = tmpDir();
  const pidFile = path.join(dir, 'grandchild.pid');
  const readyFile = path.join(dir, 'ready');

  const result = await commandDispatch(app, 'run_shell_command', {
    command: grandchildCommand(pidFile, readyFile),
    cwd: dir,
    background: false,
    timeout: 1,
    sandboxEnabled: false,
  });

  assert.equal(result.code, -1);
  assert.match(result.stderr, /timed out/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitForDead(pid);
});

test('abort_command kills the descendant process tree for a foreground command', async () => {
  if (process.platform === 'win32') return;
  const dir = tmpDir();
  const pidFile = path.join(dir, 'grandchild.pid');
  const readyFile = path.join(dir, 'ready');
  const commandId = 'abort-tree-test';

  const running = commandDispatch(app, 'run_shell_command', {
    commandId,
    command: grandchildCommand(pidFile, readyFile),
    cwd: dir,
    background: false,
    timeout: 60,
    sandboxEnabled: false,
  });
  const pid = await readPid(pidFile);
  const aborted = await commandDispatch(app, 'abort_command', { commandId });
  assert.equal(aborted, true);

  const result = await running;
  assert.notEqual(result.code, 0);
  await waitForDead(pid);
});

test('abort_command also kills a descendant that creates a new Unix process group', async () => {
  if (process.platform === 'win32') return;
  const dir = tmpDir();
  const pidFile = path.join(dir, 'detached-grandchild.pid');
  const commandId = 'abort-detached-tree-test';

  const running = commandDispatch(app, 'run_shell_command', {
    commandId,
    command: detachedGrandchildCommand(pidFile),
    cwd: dir,
    background: false,
    timeout: 60,
    sandboxEnabled: false,
  });
  const pid = await readPid(pidFile);
  assert.equal(await commandDispatch(app, 'abort_command', { commandId }), true);

  const result = await running;
  assert.notEqual(result.code, 0);
  await waitForDead(pid);
});

test('background command remains tracked and teardown kills its descendant tree', async () => {
  if (process.platform === 'win32') return;
  const dir = tmpDir();
  const pidFile = path.join(dir, 'grandchild.pid');
  const readyFile = path.join(dir, 'ready');

  const result = await commandDispatch(app, 'run_shell_command', {
    commandId: 'background-tree-test',
    command: grandchildCommand(pidFile, readyFile),
    cwd: dir,
    background: true,
    timeout: 60,
    sandboxEnabled: false,
  });
  assert.equal(result.code, 0);
  const pid = await readPid(pidFile);
  assert.equal(pidAlive(pid), true);

  teardownCommandHost();
  await waitForDead(pid);
});

test('a direct target exit does not release same-group descendants from the registry', async () => {
  if (process.platform === 'win32') return;
  const dir = tmpDir();
  const pidFile = path.join(dir, 'orphaned-child.pid');
  const commandId = 'parent-exit-tree-test';

  let settled = false;
  const running = commandDispatch(app, 'run_shell_command', {
    commandId,
    command: orphanedSameGroupChildCommand(pidFile),
    cwd: dir,
    background: false,
    timeout: 60,
    sandboxEnabled: false,
  }).finally(() => {
    settled = true;
  });
  const pid = await readPid(pidFile);
  await wait(200);
  assert.equal(settled, false, 'launcher must retain ownership after the direct target exits');
  assert.equal(await commandDispatch(app, 'abort_command', { commandId }), true);

  const result = await running;
  assert.notEqual(result.code, 0);
  await waitForDead(pid);
});

test('hard-killing the Electron parent closes the liveness pipe and kills the command tree', async () => {
  if (process.platform === 'win32') return;
  const dir = tmpDir();
  const pidFile = path.join(dir, 'hard-crash-child.pid');
  const parentReady = path.join(dir, 'parent-ready');
  const command = grandchildCommand(pidFile, path.join(dir, 'target-ready'));
  const commandHostPath = path.join(__dirname, 'commandHost.cjs');
  const harness = `
    const fs = require('node:fs');
    const { commandDispatch } = require(${JSON.stringify(commandHostPath)});
    const app = { isPackaged: false, once() {} };
    void commandDispatch(app, 'run_shell_command', {
      commandId: 'hard-crash-owned-tree',
      command: ${JSON.stringify(command)},
      cwd: ${JSON.stringify(dir)},
      background: false,
      timeout: 60,
      sandboxEnabled: false,
    });
    fs.writeFileSync(${JSON.stringify(parentReady)}, 'ready');
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ['-e', harness], { stdio: 'ignore' });

  try {
    const pid = await readPid(pidFile, 60);
    assert.equal(pidAlive(pid), true);
    parent.kill('SIGKILL');
    await waitForDead(pid, 50);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
  }
});

test('registry removes one entry without losing a concurrent command with the same id', async () => {
  if (process.platform === 'win32') return;
  const dir = tmpDir();
  const pidFile = path.join(dir, 'grandchild.pid');
  const readyFile = path.join(dir, 'ready');
  const commandId = 'reused-id-race';

  const background = await commandDispatch(app, 'run_shell_command', {
    commandId,
    command: grandchildCommand(pidFile, readyFile),
    cwd: dir,
    background: true,
    timeout: 60,
    sandboxEnabled: false,
  });
  assert.equal(background.code, 0);
  const pid = await readPid(pidFile);

  const quick = await commandDispatch(app, 'run_shell_command', {
    commandId,
    command: 'printf done',
    background: false,
    timeout: 5,
    sandboxEnabled: false,
  });
  assert.equal(quick.code, 0);

  assert.equal(await commandDispatch(app, 'abort_command', { commandId }), true);
  await waitForDead(pid);
});

test('Windows sandbox spec uses ConstrainedLanguage and Restricted execution policy', () => {
  const spec = buildSandboxedCommandSpec('Write-Output ok', 'C:\\tmp', [], true, undefined, 'win32');
  assert.equal(spec.file, 'powershell');
  assert.deepEqual(spec.args.slice(0, 5), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Restricted',
    '-Command',
  ]);
  assert.match(spec.args[5], /ConstrainedLanguage/);
  assert.match(spec.args[5], /Write-Output ok/);
});

test('Windows argv compatibility stays literal while launcher receives restricted-token intent', () => {
  const sandboxed = buildSandboxedArgvCommandSpec(
    'python',
    ['-c', 'print("ok")'],
    'C:\\tmp',
    [],
    true,
    undefined,
    'win32'
  );
  const unsandboxed = buildSandboxedArgvCommandSpec(
    'python',
    ['-c', 'print("ok")'],
    'C:\\tmp',
    [],
    false,
    undefined,
    'win32'
  );

  assert.deepEqual(sandboxed, unsandboxed);
  assert.deepEqual(makeLauncherConfig(sandboxed, true), {
    file: 'python',
    args: ['-c', 'print("ok")'],
    sandboxEnabled: true,
    monitorParent: true,
  });
  assert.equal(makeLauncherConfig(unsandboxed, false).sandboxEnabled, false);
});

test('Windows launcher statically wires restricted token and bounded handle inheritance', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'sandbox-launcher', 'src', 'main.rs'),
    'utf8'
  );
  assert.match(source, /CreateRestrictedToken/);
  assert.match(source, /DISABLE_MAX_PRIVILEGE/);
  assert.match(source, /CreateProcessAsUserW/);
  assert.match(source, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(source, /CreateProcessW\(\s*null\(\),/);
  assert.match(source, /CreateProcessAsUserW\(\s*token\.raw\(\),\s*null\(\),/);
  assert.match(source, /QueryInformationJobObject/);
  assert.match(source, /JobObjectBasicAccountingInformation/);
  assert.match(source, /ActiveProcesses/);
});

test('command host leaves SIGINT and SIGTERM exit ownership to the main process', () => {
  const source = fs.readFileSync(path.join(__dirname, 'commandHost.cjs'), 'utf8');
  assert.doesNotMatch(source, /process\.once\(['"]SIGINT['"]/);
  assert.doesNotMatch(source, /process\.once\(['"]SIGTERM['"]/);
  assert.match(source, /process\.once\(['"]exit['"], cleanup\)/);
  assert.match(source, /app\?\.once\?\.\(['"]before-quit['"], cleanup\)/);
});

test('macOS Seatbelt profile still denies sensitive home paths', () => {
  const profile = generateSeatbeltProfile('/tmp/work', [], '/Users/tester', undefined);
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /deny file-read\* \(subpath "\/Users\/tester\/\.ssh"\)/);
  assert.match(profile, /deny file-read\* \(subpath "\/Users\/tester\/\.aws\/credentials"\)/);
});
