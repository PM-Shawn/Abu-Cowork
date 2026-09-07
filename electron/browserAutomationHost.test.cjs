'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const browserHostPath = path.join(__dirname, 'browserHost.cjs');
const calls = [];
/**
 * Reassignable so individual tests (the abort-to-main ones below) can swap in
 * a double that inspects the `opts.signal` `handleRequest` passes as the 3rd
 * arg, then restore this default in `afterEach`.
 */
let performBrowserAutomationImpl = async (action, payload) => {
  calls.push({ action, payload });
  return { action, payload };
};
require.cache[browserHostPath] = {
  id: browserHostPath,
  filename: browserHostPath,
  loaded: true,
  exports: {
    performBrowserAutomation: (...args) => performBrowserAutomationImpl(...args),
  },
};

const {
  ensureBrowserAutomationServer,
  resolveBrowserRuntimeLaunch,
  stopBrowserAutomationServer,
} = require('./browserAutomationHost.cjs');

afterEach(() => {
  calls.length = 0;
  performBrowserAutomationImpl = async (action, payload) => {
    calls.push({ action, payload });
    return { action, payload };
  };
  stopBrowserAutomationServer();
});

test('browser automation host uses a random authenticated loopback endpoint', async () => {
  const first = await ensureBrowserAutomationServer();
  const parsed = new URL(first.endpoint);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/action');
  assert.notEqual(parsed.port, '9875');
  assert.notEqual(parsed.port, '9876');
  assert.equal(first.endpoint.includes(first.token), false);
  assert.match(first.token, /^[a-f0-9]{64}$/);

  const unauthorized = await fetch(first.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get_tabs', payload: {} }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(calls.length, 0);

  const authorized = await fetch(first.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${first.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'snapshot', payload: { tabId: 42 } }),
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), {
    success: true,
    data: { action: 'snapshot', payload: { tabId: 42 } },
  });
  assert.deepEqual(calls, [{ action: 'snapshot', payload: { tabId: 42 } }]);
});

test('stopping during startup cancels that generation and allows a clean restart', async () => {
  const pending = ensureBrowserAutomationServer();
  stopBrowserAutomationServer();
  await assert.rejects(pending, /start was cancelled/);

  const restarted = await ensureBrowserAutomationServer();
  assert.match(restarted.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/action$/);
  assert.match(restarted.token, /^[a-f0-9]{64}$/);
});

test('browser runtime launch uses bundled Node and keeps credentials in child env', async () => {
  const launch = await resolveBrowserRuntimeLaunch({ isPackaged: false });
  assert.equal(launch.command, 'node');
  assert.equal(launch.args.length, 1);
  assert.match(launch.args[0], /electron[/\\]browser-runtime[/\\]dist[/\\]server\.mjs$/);
  assert.match(launch.env.ABU_BROWSER_RUNTIME_ENDPOINT, /^http:\/\/127\.0\.0\.1:\d+\/action$/);
  assert.match(launch.env.ABU_BROWSER_RUNTIME_TOKEN, /^[a-f0-9]{64}$/);
});

/**
 * Abort-to-main: `handleRequest` builds an `AbortController` per request and
 * aborts it when the client connection closes early (the run being stopped),
 * passing `{ signal }` as `performBrowserAutomation`'s 3rd argument. These
 * tests exercise the real HTTP layer (unlike the mocked `performBrowserAutomation`
 * calls above) since the behavior under test lives entirely in the request
 * lifecycle, not in browserHost.cjs.
 */
test('closing the client connection mid-action aborts the signal passed to performBrowserAutomation', async () => {
  let capturedSignal = null;
  let resolveAction;
  performBrowserAutomationImpl = (action, payload, opts) => {
    capturedSignal = opts && opts.signal;
    return new Promise((resolve) => {
      resolveAction = resolve;
    });
  };

  const { endpoint, token } = await ensureBrowserAutomationServer();
  const url = new URL(endpoint);

  await new Promise((resolve) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    // The client vanishing (run stopped) surfaces locally as a socket error —
    // that is the scenario under test, not a bug in the request.
    req.on('error', () => {});
    req.end(JSON.stringify({ action: 'click', payload: {} }));
    // Let the server start handling the request (readJsonBody resolves, then
    // performBrowserAutomation is invoked and captures the signal) before the
    // client disappears out from under it.
    setImmediate(() => setImmediate(() => {
      req.destroy();
      resolve();
    }));
  });

  // Give the server's `req.on('close', ...)` handler a tick to fire.
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(capturedSignal, 'performBrowserAutomation must have been called with a signal');
  assert.equal(capturedSignal.aborted, true, 'the signal must abort when the client connection closes early');

  // The action "finishes" long after the client is gone — nothing should throw.
  resolveAction({ ok: true });
});

test('a request that completes normally never aborts its own action signal', async () => {
  let capturedSignal = null;
  performBrowserAutomationImpl = async (action, payload, opts) => {
    capturedSignal = opts && opts.signal;
    return { action, payload };
  };

  const { endpoint, token } = await ensureBrowserAutomationServer();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'snapshot', payload: {} }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: { action: 'snapshot', payload: {} } });

  // The request's socket also emits `close` right after a normal response —
  // give that a tick, then confirm it did NOT get mistaken for an abort.
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(capturedSignal, 'performBrowserAutomation must have been called with a signal');
  assert.equal(capturedSignal.aborted, false, 'a normal completion must not misfire the abort signal');
});
