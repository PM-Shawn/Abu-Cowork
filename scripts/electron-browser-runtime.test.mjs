import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const bundlePath = path.resolve(root, 'electron/browser-runtime/dist/server.mjs');
const buildScriptPath = path.resolve(root, 'scripts/build-electron-browser-runtime.mjs');
const runtimeToken = 'test-runtime-token-5f421ee71e2447dc';

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`node ${args.join(' ')} exited ${String(code)}\n${stderr}`));
      }
    });
  });
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      assert(address && typeof address === 'object');
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function reservePort(port) {
  const server = net.createServer();
  await listen(server, port);
  return server;
}

async function readRequestBody(request) {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  await once(request, 'end');
  return Buffer.concat(chunks).toString('utf8');
}

function createMockHost() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await readRequestBody(request);
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: false, error: 'invalid json' }));
      return;
    }

    const record = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      parsed,
    };
    requests.push(record);

    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: parsed?.id, success: false, error: 'method not allowed' }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${runtimeToken}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: parsed?.id, success: false, error: 'unauthorized' }));
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: parsed?.id,
      success: true,
      data: {
        currentTabId: 7,
        windows: [{
          windowId: 1,
          focused: true,
          tabs: [{
            tabId: 7,
            title: 'Mock Browser Tab',
            url: 'https://example.test/',
            active: true,
          }],
        }],
      },
    }));
  });
  return { server, requests };
}

function createMcpClient(endpoint) {
  const child = spawn(process.execPath, [bundlePath], {
    cwd: root,
    env: {
      ...process.env,
      ABU_BROWSER_RUNTIME_ENDPOINT: endpoint,
      ABU_BROWSER_RUNTIME_TOKEN: runtimeToken,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  let stdoutBuffer = '';
  let stderr = '';
  let closed = false;
  let closePromise = null;
  const pending = new Map();

  function failAll(err) {
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk;
    let nl;
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, nl).trim();
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        failAll(new Error(`non-JSON stdout from MCP bundle: ${line}`));
        continue;
      }
      if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
        const request = pending.get(message.id);
        if (request) {
          clearTimeout(request.timer);
          pending.delete(message.id);
          request.resolve(message);
        }
      }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', failAll);
  child.on('close', code => {
    closed = true;
    failAll(new Error(`MCP bundle exited before test finished: ${String(code)}\n${stderr}`));
  });

  function send(method, params) {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 5_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async function close() {
    if (closed) return stderr;
    if (closePromise) return closePromise;
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
    child.kill('SIGTERM');
    closePromise = once(child, 'close').catch(() => {}).then(() => stderr);
    return closePromise;
  }

  return { send, notify, close };
}

test('electron browser runtime bundle serves MCP over stdio and proxies get_tabs over authenticated HTTP POST', async () => {
  await runNode([buildScriptPath]);

  const legacyPorts = await Promise.all([reservePort(9875), reservePort(9876)]);
  const mock = createMockHost();
  const mockPort = await listen(mock.server);
  const endpoint = `http://127.0.0.1:${mockPort}/browser-runtime`;
  const client = createMcpClient(endpoint);

  try {
    const initialize = await client.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'electron-browser-runtime-test', version: '0.0.0' },
    });
    assert.equal(initialize.error, undefined);
    client.notify('notifications/initialized', {});

    const listTools = await client.send('tools/list', {});
    assert.equal(listTools.error, undefined);
    const tools = listTools.result.tools;
    assert(Array.isArray(tools));
    const getTabs = tools.find(tool => tool.name === 'get_tabs');
    assert(getTabs);
    assert.equal(/Chrome/i.test(getTabs.description), false);

    const callTool = await client.send('tools/call', {
      name: 'get_tabs',
      arguments: {},
    });
    assert.equal(callTool.error, undefined);
    assert.equal(callTool.result.content[0].type, 'text');
    assert.match(callTool.result.content[0].text, /Mock Browser Tab/);

    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].method, 'POST');
    assert.equal(mock.requests[0].url, '/browser-runtime');
    assert.equal(mock.requests[0].authorization, `Bearer ${runtimeToken}`);
    assert.equal(mock.requests[0].parsed.action, 'get_tabs');
    assert.deepEqual(mock.requests[0].parsed.payload, {});

    const stderr = await client.close();
    assert.equal(stderr.includes(runtimeToken), false);
  } finally {
    await client.close().catch(() => {});
    await new Promise(resolve => mock.server.close(resolve));
    await Promise.all(legacyPorts.map(server => new Promise(resolve => server.close(resolve))));
  }
});
