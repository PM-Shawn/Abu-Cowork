'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const {
  commandDispatch,
  teardownCommandHost,
  buildSandboxedCommandSpec,
  buildSandboxedArgvCommandSpec,
  makeLauncherConfig,
  generateSeatbeltProfile,
  rewriteWindowsBundledPythonCommand,
  installBackgroundCommands,
  __resetCommandHostForTests,
} = require('./commandHost.cjs');
const { createBackgroundCommands, BACKGROUND_COMMANDS_CHANGED_EVENT } = require('./backgroundCommands.cjs');
const { getRuntimeDiagnostics } = require('./runtimeObservability.cjs');

const app = { isPackaged: false, once() {} };
const TICK_COMMAND = `node -e "setInterval(()=>console.log('tick'),100)"`;
let backgroundEvents = [];

function lastCommandFinishedEvent() {
  return getRuntimeDiagnostics()
    .recentEventLines.map((line) => JSON.parse(line))
    .filter((event) => event.event === 'main.command_finished')
    .at(-1);
}

test('Windows shell rewrites bare Python aliases to the bundled executable', () => {
  const resourceRoot = tmpDir();
  const pythonExecutable = path.join(resourceRoot, 'python-runtime', 'python.exe');
  fs.mkdirSync(path.dirname(pythonExecutable), { recursive: true });
  fs.writeFileSync(pythonExecutable, '');
  const packagedApp = { isPackaged: true };
  const options = { platform: 'win32', resourceRoot };

  for (const alias of ['python', 'python3', 'python3.12', 'py', 'PYTHON3.EXE']) {
    assert.equal(
      rewriteWindowsBundledPythonCommand(packagedApp, `${alias} script.py --flag`, options),
      `& '${pythonExecutable}' -B script.py --flag`,
    );
  }
  assert.equal(
    rewriteWindowsBundledPythonCommand(packagedApp, 'py -3.12 script.py --flag', options),
    `& '${pythonExecutable}' -B script.py --flag`,
  );
  assert.equal(
    rewriteWindowsBundledPythonCommand(packagedApp, 'py -3 -c "print(1)"', options),
    `& '${pythonExecutable}' -B -c "print(1)"`,
  );
});

test('Windows shell preserves explicit paths and non-leading Python tokens', () => {
  const options = { platform: 'win32', resourceRoot: tmpDir() };
  const packagedApp = { isPackaged: true };

  for (const command of [
    'C:\\Tools\\python.exe script.py',
    '.\\python3 script.py',
    'Write-Output python3',
    'echo ready; python3 script.py',
  ]) {
    assert.equal(rewriteWindowsBundledPythonCommand(packagedApp, command, options), command);
  }
});

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

function countTicks(text) {
  return (text.match(/tick/g) || []).length;
}

function backgroundRow(conversationId, id) {
  return commandDispatch(app, 'background_command_list', { conversationId }).then((rows) =>
    rows.find((row) => row.id === id),
  );
}

async function waitForBackgroundRow(conversationId, id, predicate, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) {
    const row = await backgroundRow(conversationId, id);
    if (row && predicate(row)) return row;
    await wait(50);
  }
  throw new Error(`background command ${id} did not reach the expected state`);
}

function startBackground(conversationId, command, extra = {}) {
  return commandDispatch(app, 'run_shell_command', {
    command,
    conversationId,
    background: true,
    timeout: 60,
    sandboxEnabled: false,
    ...extra,
  });
}

beforeEach(() => {
  backgroundEvents = [];
  let clock = 0;
  installBackgroundCommands(
    createBackgroundCommands({
      emit: (event, payload) => backgroundEvents.push({ event, payload }),
      now: () => (clock += 1),
      randomId: crypto.randomBytes,
      legacyEncoding: () => null,
    }),
  );
});

afterEach(() => {
  __resetCommandHostForTests();
});

test('run_shell_command executes ordinary shell commands through launcher', async () => {
  const result = await commandDispatch(app, 'run_shell_command', {
    command: process.platform === 'win32' ? 'Write-Host -NoNewline hello' : 'printf hello',
    background: false,
    timeout: 5,
    sandboxEnabled: false,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hello');
});

test('macOS sandbox hard-denies osascript through shell and interpreter wrappers', {
  skip: process.platform !== 'darwin',
}, async () => {
  const commands = [
    `tool=/usr/bin/osascript; "$tool" -e 'return 1'`,
    `eval '/usr/bin/osascript -e "return 1"'`,
    `python -c 'import subprocess; subprocess.run(["/usr/bin/osascript", "-e", "return 1"], check=True)'`,
  ];

  for (const command of commands) {
    const result = await commandDispatch(app, 'run_shell_command', {
      command,
      background: false,
      timeout: 5,
      sandboxEnabled: true,
    });
    assert.notEqual(result.code, 0, command);
    assert.match(result.stderr, /\[sandbox-blocked\]/i, command);
    assert.match(result.stderr, /operation not permitted/i, command);
  }
});

test('macOS sandbox prevents copying osascript to a writable alias', {
  skip: process.platform !== 'darwin',
}, async () => {
  const dir = tmpDir();
  const alias = path.join(dir, 'helper');
  const result = await commandDispatch(app, 'run_shell_command', {
    command: `cp /usr/bin/osascript ${shellQuote(alias)}`,
    cwd: dir,
    background: false,
    timeout: 5,
    sandboxEnabled: true,
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /\[sandbox-blocked\]/i);
  assert.equal(fs.existsSync(alias), false);
});

test('macOS cannot execute an osascript alias copied before sandbox launch', {
  skip: process.platform !== 'darwin',
}, async () => {
  const dir = tmpDir();
  const alias = path.join(dir, 'helper');
  fs.copyFileSync('/usr/bin/osascript', alias);
  fs.chmodSync(alias, 0o755);

  const result = await commandDispatch(app, 'run_shell_command', {
    command: `${shellQuote(alias)} -e 'return 1'`,
    cwd: dir,
    background: false,
    timeout: 5,
    sandboxEnabled: true,
  });

  assert.notEqual(result.code, 0);
});

test('foreground shell execution records a diagnostics event with command, exit code, and duration', async () => {
  const result = await commandDispatch(app, 'run_shell_command', {
    command: process.platform === 'win32' ? 'Write-Host -NoNewline observed-foreground' : 'printf observed-foreground',
    background: false,
    timeout: 5,
    sandboxEnabled: false,
  });
  assert.equal(result.code, 0);

  const event = lastCommandFinishedEvent();
  assert.ok(event, 'run_shell_command must record a main.command_finished event');
  assert.match(event.command, /observed-foreground/);
  assert.equal(event.exitCode, 0);
  assert.equal(event.sandboxEnabled, false);
  assert.equal(event.executionPath, 'foreground');
  assert.equal(event.outcome, 'success');
  assert.equal(typeof event.durationMs, 'number');
});

test('foreground shell execution records a non-zero exit code as an error outcome', async () => {
  const result = await commandDispatch(app, 'run_shell_command', {
    command: 'exit 7',
    background: false,
    timeout: 5,
    sandboxEnabled: false,
  });
  assert.equal(result.code, 7);

  const event = lastCommandFinishedEvent();
  assert.equal(event.exitCode, 7);
  assert.equal(event.outcome, 'error');
});

test('background shell execution records a diagnostics event when the process exits', async () => {
  const result = await commandDispatch(app, 'run_shell_command', {
    command: process.platform === 'win32' ? 'Write-Host -NoNewline observed-background' : 'printf observed-background',
    conversationId: 'c-diagnostics',
    background: true,
    timeout: 5,
    sandboxEnabled: false,
  });
  assert.equal(result.code, 0);

  const event = lastCommandFinishedEvent();
  assert.ok(event, 'background run_shell_command must record a main.command_finished event');
  assert.match(event.command, /observed-background/);
  assert.equal(event.exitCode, 0);
  assert.equal(event.sandboxEnabled, false);
  assert.equal(event.executionPath, 'background');
});

test('argv execution records a diagnostics event with the program summary', async () => {
  const result = await commandDispatch(app, 'run_argv_command', {
    program: process.execPath,
    args: ['-e', 'process.exit(0)', 'observed-argv'],
    timeout: 5,
    sandboxEnabled: false,
  });
  assert.equal(result.code, 0);

  const event = lastCommandFinishedEvent();
  assert.ok(event, 'run_argv_command must record a main.command_finished event');
  assert.match(event.command, /observed-argv/);
  assert.equal(event.exitCode, 0);
  assert.equal(event.executionPath, 'foreground');
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

test('bare Node, npm, and npx commands execute from the bundled runtime', async () => {
  const expectedNode = path.join(
    __dirname,
    '.runtime',
    'node-runtime',
    process.platform === 'win32' ? 'node.exe' : 'bin/node',
  );
  const nodeResult = await commandDispatch(app, 'run_argv_command', {
    program: 'node',
    args: ['-e', 'process.stdout.write(process.execPath)'],
    timeout: 10,
    sandboxEnabled: false,
  });
  const npmResult = await commandDispatch(app, 'run_argv_command', {
    program: 'npm',
    args: ['--version'],
    timeout: 10,
    sandboxEnabled: false,
  });
  const npxResult = await commandDispatch(app, 'run_argv_command', {
    program: 'npx',
    args: ['--version'],
    timeout: 10,
    sandboxEnabled: false,
  });

  assert.equal(nodeResult.code, 0);
  assert.equal(path.resolve(nodeResult.stdout), path.resolve(expectedNode));
  assert.equal(npmResult.code, 0);
  assert.match(npmResult.stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal(npxResult.code, 0);
  assert.match(npxResult.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('bare Python runs bundled Office and PDF dependencies in an isolated environment', async () => {
  const result = await commandDispatch(app, 'run_argv_command', {
    program: 'python3',
    args: [
      '-c',
      [
        'import json, os, sys',
        'import docx, openpyxl, pdfplumber, pptx, reportlab',
        'print(json.dumps({',
        '  "executable": sys.executable,',
        '  "pythonPath": os.environ.get("PYTHONPATH"),',
        '  "userSite": os.environ.get("PYTHONNOUSERSITE"),',
        '  "writeBytecode": os.environ.get("PYTHONDONTWRITEBYTECODE"),',
        '}))',
      ].join('\n'),
    ],
    timeout: 20,
    sandboxEnabled: false,
  });
  const expectedPython = path.join(
    __dirname,
    '.runtime',
    'python-runtime',
    process.platform === 'win32' ? 'python.exe' : 'bin/python3',
  );

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(path.resolve(output.executable), path.resolve(expectedPython));
  assert.equal(output.pythonPath, '');
  assert.equal(output.userSite, '1');
  assert.equal(output.writeBytecode, '1');
});

test('shell commands prefer the bundled Node directory on PATH', async () => {
  const result = await commandDispatch(app, 'run_shell_command', {
    command: 'node -e "process.stdout.write(process.execPath)"',
    background: false,
    timeout: 10,
    sandboxEnabled: false,
  });
  const expectedNode = path.join(
    __dirname,
    '.runtime',
    'node-runtime',
    process.platform === 'win32' ? 'node.exe' : 'bin/node',
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(path.resolve(result.stdout), path.resolve(expectedNode));
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
    conversationId: 'c-teardown',
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
    conversationId: 'c-reused-id',
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

test('registers a background command and returns its id', async () => {
  const result = await startBackground('c1', TICK_COMMAND);

  assert.equal(result.code, 0);
  assert.match(result.backgroundCommandId, /^bg-[0-9a-f]{8}$/);
  assert.equal(result.running, true);
  assert.ok(countTicks(result.stdout) > 0, 'the first three seconds of output are still returned');
  const rows = await commandDispatch(app, 'background_command_list', { conversationId: 'c1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, result.backgroundCommandId);
  assert.equal(rows[0].command, TICK_COMMAND);
  assert.equal(rows[0].status, 'running');
  assert.equal(await commandDispatch(app, 'background_command_running_count', { conversationId: 'c1' }), 1);
  assert.equal(await commandDispatch(app, 'background_command_running_count', {}), 1);
  assert.ok(
    backgroundEvents.some(
      ({ event, payload }) => event === BACKGROUND_COMMANDS_CHANGED_EVENT && payload.conversationId === 'c1',
    ),
  );
});

test('reports a background command that exits within three seconds as not running', async () => {
  const result = await startBackground('c1', 'printf done');

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'done');
  assert.match(result.backgroundCommandId, /^bg-[0-9a-f]{8}$/);
  assert.equal(result.running, false);
});

test('reads output written after the first three seconds', async () => {
  const result = await startBackground('c1', TICK_COMMAND);
  const initialTicks = countTicks(result.stdout);
  const id = result.backgroundCommandId;

  let output = null;
  for (let i = 0; i < 100; i += 1) {
    output = await commandDispatch(app, 'background_command_output', { conversationId: 'c1', id, since: 0 });
    if (countTicks(output.text) > initialTicks) break;
    await wait(50);
  }
  assert.ok(countTicks(output.text) > initialTicks, 'output keeps growing after the tool result returned');
  assert.equal(output.gap, false);
  assert.equal(output.status, 'running');

  const later = await commandDispatch(app, 'background_command_output', {
    conversationId: 'c1',
    id,
    since: output.next,
  });
  assert.ok(later.next >= output.next);
});

test('records the real exit code', async () => {
  const command = `node -e "setTimeout(()=>process.exit(3),3500)"`;
  const result = await startBackground('c1', command);
  assert.equal(result.code, 0, 'the command is still running when the tool result returns');

  const row = await waitForBackgroundRow('c1', result.backgroundCommandId, (r) => r.status !== 'running');
  assert.equal(row.status, 'failed');
  assert.equal(row.exitCode, 3);
  const event = lastCommandFinishedEvent();
  assert.equal(event.command, command);
  assert.equal(event.exitCode, 3);
  assert.equal(event.executionPath, 'background');
});

test('marks an aborted background command as stopped', async () => {
  const commandId = 'abort-background-test';
  const result = await startBackground('c1', TICK_COMMAND, { commandId });
  const id = result.backgroundCommandId;

  assert.equal(await commandDispatch(app, 'abort_command', { commandId }), true);
  assert.equal((await backgroundRow('c1', id)).status, 'stopping');

  const row = await waitForBackgroundRow('c1', id, (r) => r.status !== 'stopping');
  assert.equal(row.status, 'stopped');
});

test('stops through background_command_stop', async () => {
  const result = await startBackground('c1', TICK_COMMAND);
  const id = result.backgroundCommandId;

  assert.equal(await commandDispatch(app, 'background_command_stop', { conversationId: 'c1', id }), 'requested');
  assert.equal((await backgroundRow('c1', id)).status, 'stopping');

  const row = await waitForBackgroundRow('c1', id, (r) => r.status !== 'stopping');
  assert.equal(row.status, 'stopped');
  assert.equal(
    await commandDispatch(app, 'background_command_stop', { conversationId: 'c1', id }),
    'already-finished',
  );
  assert.equal(await commandDispatch(app, 'background_command_running_count', { conversationId: 'c1' }), 0);

  await commandDispatch(app, 'background_command_clear', { conversationId: 'c1' });
  assert.deepEqual(await commandDispatch(app, 'background_command_list', { conversationId: 'c1' }), []);
});

test('stops a conversation and removes its rows', async () => {
  const result = await startBackground('c1', TICK_COMMAND);

  await commandDispatch(app, 'background_command_stop_conversation', { conversationId: 'c1' });
  assert.deepEqual(await commandDispatch(app, 'background_command_list', { conversationId: 'c1' }), []);
  assert.equal(await commandDispatch(app, 'background_command_running_count', {}), 0);
  await assert.rejects(
    commandDispatch(app, 'background_command_output', {
      conversationId: 'c1',
      id: result.backgroundCommandId,
      since: 0,
    }),
    /does not exist/,
  );
});

test("refuses to read or stop another conversation's command", async () => {
  const result = await startBackground('c1', TICK_COMMAND);
  const id = result.backgroundCommandId;

  await assert.rejects(
    commandDispatch(app, 'background_command_output', { conversationId: 'c2', id, since: 0 }),
    /does not belong to conversation c2/,
  );
  await assert.rejects(
    commandDispatch(app, 'background_command_stop', { conversationId: 'c2', id }),
    /does not belong to conversation c2/,
  );
  await assert.rejects(
    commandDispatch(app, 'background_command_stop', { conversationId: 'c1', id: 'bg-00000000' }),
    /does not exist/,
  );
  await commandDispatch(app, 'background_command_stop_conversation', { conversationId: 'c2' });
  assert.deepEqual(await commandDispatch(app, 'background_command_list', { conversationId: 'c2' }), []);
  assert.equal((await backgroundRow('c1', id)).status, 'running');
});

test('rejects a background run without conversationId', async () => {
  await assert.rejects(
    commandDispatch(app, 'run_shell_command', {
      command: TICK_COMMAND,
      background: true,
      timeout: 60,
      sandboxEnabled: false,
    }),
    /conversationId/,
  );
  assert.equal(await commandDispatch(app, 'background_command_running_count', {}), 0);
});

test('does not list a command that failed to start', async () => {
  const absentCwd = path.join(__dirname, 'no-such-directory-for-background-commands');
  const missing = await startBackground('c1', TICK_COMMAND, { cwd: absentCwd });

  assert.equal(missing.code, -1);
  assert.ok(missing.stderr.includes(absentCwd));
  assert.equal(missing.backgroundCommandId, undefined);
  assert.deepEqual(await commandDispatch(app, 'background_command_list', { conversationId: 'c1' }), []);
  assert.deepEqual(backgroundEvents, []);
});

test('removes the row when the process reports an error after spawn', {
  skip: process.platform === 'win32',
}, async () => {
  // The directory passes the preflight check, but the launcher cannot enter
  // it, so spawn() returns and the child reports EACCES afterwards.
  const lockedCwd = tmpDir();
  fs.chmodSync(lockedCwd, 0o000);
  try {
    const result = await startBackground('c1', TICK_COMMAND, { cwd: lockedCwd });

    assert.equal(result.code, -1);
    assert.match(result.stderr, /EACCES/);
    assert.equal(result.backgroundCommandId, undefined);
    assert.deepEqual(await commandDispatch(app, 'background_command_list', { conversationId: 'c1' }), []);
    assert.deepEqual(
      backgroundEvents.map(({ payload }) => payload.conversationId),
      ['c1', 'c1'],
      'one event when the row was registered and one when it was removed',
    );
  } finally {
    fs.chmodSync(lockedCwd, 0o700);
    fs.rmSync(lockedCwd, { recursive: true, force: true });
  }
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
    parentPid: process.pid,
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

test('launcher statically reports NTSTATUS exit codes on stderr for diagnosability', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'sandbox-launcher', 'src', 'main.rs'),
    'utf8'
  );
  assert.match(source, /ntstatus_exit_hint/);
  assert.match(source, /STATUS_DLL_INIT_FAILED/);
  assert.match(source, /STATUS_DLL_NOT_FOUND/);
  assert.match(source, /STATUS_ACCESS_VIOLATION/);
  assert.match(source, /child exited with NTSTATUS/);
});

test('command host leaves SIGINT and SIGTERM exit ownership to the main process', () => {
  const source = fs.readFileSync(path.join(__dirname, 'commandHost.cjs'), 'utf8');
  assert.doesNotMatch(source, /process\.once\(['"]SIGINT['"]/);
  assert.doesNotMatch(source, /process\.once\(['"]SIGTERM['"]/);
  assert.match(source, /process\.once\(['"]exit['"], cleanup\)/);
  assert.match(source, /app\?\.once\?\.\(['"]will-quit['"], cleanup\)/);
  assert.doesNotMatch(source, /['"]before-quit['"], cleanup/);
});

test('run_shell_command with a missing working directory names the directory, not the launcher', async () => {
  const absentCwd = path.join(tmpDir(), 'no-such-directory');

  const result = await commandDispatch(app, 'run_shell_command', {
    command: 'echo hello',
    cwd: absentCwd,
    sandboxEnabled: false,
  });

  assert.equal(result.code, -1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(absentCwd), '错误文本要指名工作目录');
  assert.doesNotMatch(result.stderr, /sandbox-launcher/, '错误文本不能再指向启动器');
});

test('macOS Seatbelt profile still denies sensitive home paths', () => {
  const profile = generateSeatbeltProfile('/tmp/work', [], '/Users/tester', undefined);
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(deny process-exec \(literal "\/usr\/bin\/osascript"\)\)/);
  assert.match(profile, /\(deny file-read\* \(literal "\/usr\/bin\/osascript"\)\)/);
  assert.match(profile, /\(deny appleevent-send\)/);
  assert.match(profile, /deny file-read\* \(subpath "\/Users\/tester\/\.ssh"\)/);
  assert.match(profile, /deny file-read\* \(subpath "\/Users\/tester\/\.aws\/credentials"\)/);
});

test('macOS commands use the configured temporary directory and keep adjacent paths protected', { skip: process.platform !== 'darwin' }, () => {
  const fixtureDirectory = path.join(__dirname, '..', '.agent');
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureDirectory, 'command-temporary-'));
  const temporaryDirectory = path.join(root, 'temporary "files"');
  const sibling = path.join(root, 'sibling');
  const alias = path.join(root, 'temporary-alias');
  fs.mkdirSync(temporaryDirectory);
  fs.mkdirSync(sibling);
  fs.symlinkSync(temporaryDirectory, alias, 'dir');
  const escapeAlias = path.join(temporaryDirectory, 'outside');
  fs.symlinkSync(sibling, escapeAlias, 'dir');
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = alias;
    const execute = spec => spawnSync(spec.file, spec.args, {
      encoding: 'utf8', env: { ...process.env, ...spec.env }, timeout: 10_000,
    });
    const shellTarget = path.join(alias, 'shell.txt');
    const shell = execute(buildSandboxedCommandSpec(`/usr/bin/touch ${shellQuote(shellTarget)}`, undefined, [], true));
    assert.ifError(shell.error);
    assert.equal(shell.status, 0, shell.stderr);
    assert.ok(fs.existsSync(shellTarget));
    const argvTarget = path.join(alias, 'argv.txt');
    const argv = execute(buildSandboxedArgvCommandSpec('/usr/bin/touch', [argvTarget], undefined, [], true));
    assert.ifError(argv.error);
    assert.equal(argv.status, 0, argv.stderr);
    assert.ok(fs.existsSync(argvTarget));
    for (const deniedDirectory of [sibling, escapeAlias]) {
      for (const spec of [
        buildSandboxedCommandSpec(`/usr/bin/touch ${shellQuote(path.join(deniedDirectory, 'shell.txt'))}`, undefined, [], true),
        buildSandboxedArgvCommandSpec('/usr/bin/touch', [path.join(deniedDirectory, 'argv.txt')], undefined, [], true),
      ]) {
        const denied = execute(spec);
        assert.ifError(denied.error);
        assert.notEqual(denied.status, 0);
      }
    }
    assert.deepEqual(fs.readdirSync(sibling), []);
    const profile = generateSeatbeltProfile(undefined, [], os.homedir());
    assert.ok(profile.includes(`(allow file-write* (subpath ${JSON.stringify(fs.realpathSync(temporaryDirectory))}))`));
    assert.ok(profile.includes(`(deny file-read* (subpath "${os.homedir()}/.ssh"))`));
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('macOS commands reject unsafe temporary directory configuration', { skip: process.platform !== 'darwin' }, () => {
  const fixtureDirectory = path.join(__dirname, '..', '.agent');
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureDirectory, 'command-temporary-invalid-'));
  const file = path.join(root, 'file.txt');
  const homeAlias = path.join(root, 'home-alias');
  fs.writeFileSync(file, 'data');
  fs.symlinkSync(os.homedir(), homeAlias, 'dir');
  const previous = process.env.TMPDIR;
  try {
    for (const temporaryDirectory of ['relative-directory', path.parse(root).root, os.homedir(), homeAlias, file, path.join(root, 'missing')]) {
      process.env.TMPDIR = temporaryDirectory;
      assert.throws(() => buildSandboxedCommandSpec('true', undefined, [], true));
      assert.throws(() => buildSandboxedArgvCommandSpec('/usr/bin/true', [], undefined, [], true));
    }
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
