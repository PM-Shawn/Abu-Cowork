'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const { mcpDispatch } = require('./mcpBridge.cjs');
const { REPO_ROOT } = require('./appEnv.cjs');

const app = { isPackaged: false };
const activeIds = new Set();
const tempDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-mcp-supervisor-'));
  tempDirs.push(dir);
  return dir;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, description, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

async function waitForDead(pid, description) {
  await waitUntil(() => !pidAlive(pid), description);
}

function processTreeFixture(resultPath, waitForMessage) {
  return `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const start = () => {
      const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
        executable: process.execPath,
        childPid: child.pid,
        commandHostMarker: process.env.ABU_ELECTRON_COMMAND_HOST || '',
      }));
      setInterval(() => {}, 1000);
    };
    ${waitForMessage
      ? "process.stdin.setEncoding('utf8'); process.stdin.once('data', start);"
      : 'start();'}
  `;
}

async function spawnFixture(id, resultPath, waitForMessage = true, heartbeat = false) {
  activeIds.add(id);
  await mcpDispatch(app, 'mcp_spawn', {
    id,
    command: 'node',
    args: ['-e', processTreeFixture(resultPath, waitForMessage)],
    env: {},
    heartbeat,
  });
  if (waitForMessage) {
    await mcpDispatch(app, 'mcp_write', { id, message: '{"start":true}' });
  }
  await waitUntil(() => fs.existsSync(resultPath), `${id} fixture output`);
  return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
}

afterEach(() => {
  for (const id of activeIds) mcpDispatch(app, 'mcp_kill', { id });
  activeIds.clear();
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test('MCP bare node runs the standalone bundled Node and stdio remains writable', async () => {
  const resultPath = path.join(tmpDir(), 'runtime.json');
  const result = await spawnFixture('mcp-bundled-node', resultPath, true, true);
  const expectedNode = path.join(
    REPO_ROOT,
    'electron',
    '.runtime',
    'node-runtime',
    process.platform === 'win32' ? 'node.exe' : 'bin/node',
  );

  assert.equal(path.resolve(result.executable), path.resolve(expectedNode));
  assert.equal(result.commandHostMarker, '1');
  assert.equal(pidAlive(result.childPid), true);
});

test('mcp_kill terminates the supervised descendant process tree', async () => {
  const resultPath = path.join(tmpDir(), 'kill.json');
  const result = await spawnFixture('mcp-tree-kill', resultPath);
  assert.equal(pidAlive(result.childPid), true);

  mcpDispatch(app, 'mcp_kill', { id: 'mcp-tree-kill' });
  activeIds.delete('mcp-tree-kill');
  await waitForDead(result.childPid, 'mcp_kill descendant cleanup');
});

test('native parent monitoring cleans the MCP tree after a hard parent crash', async () => {
  if (process.platform === 'win32') return;
  const dir = tmpDir();
  const resultPath = path.join(dir, 'hard-crash.json');
  const parentReadyPath = path.join(dir, 'parent-ready');
  const bridgePath = path.join(__dirname, 'mcpBridge.cjs');
  const harness = `
    const fs = require('node:fs');
    const { mcpDispatch } = require(${JSON.stringify(bridgePath)});
    const app = { isPackaged: false };
    (async () => {
      await mcpDispatch(app, 'mcp_spawn', {
        id: 'mcp-hard-crash',
        command: 'node',
        args: ['-e', ${JSON.stringify(processTreeFixture(resultPath, false))}],
        env: {},
      });
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(${JSON.stringify(resultPath)}) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!fs.existsSync(${JSON.stringify(resultPath)})) throw new Error('target did not start');
      fs.writeFileSync(${JSON.stringify(parentReadyPath)}, 'ready');
      setInterval(() => {}, 1000);
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const parent = spawn(process.execPath, ['-e', harness], { stdio: 'ignore' });

  try {
    await waitUntil(() => fs.existsSync(parentReadyPath), 'hard-crash parent readiness');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(pidAlive(result.childPid), true);
    parent.kill('SIGKILL');
    await waitForDead(result.childPid, 'native hard-crash descendant cleanup');
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
  }
});

test('MCP spawn rejects before ready when the target executable is missing', async () => {
  await assert.rejects(
    mcpDispatch(app, 'mcp_spawn', {
      id: 'mcp-missing-target',
      command: path.join(tmpDir(), 'does-not-exist'),
      args: [],
      env: {},
    }),
    /mcp_spawn failed.*failed to spawn target/s,
  );
});
