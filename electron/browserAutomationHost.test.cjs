'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const browserHostPath = path.join(__dirname, 'browserHost.cjs');
const calls = [];
require.cache[browserHostPath] = {
  id: browserHostPath,
  filename: browserHostPath,
  loaded: true,
  exports: {
    performBrowserAutomation: async (action, payload) => {
      calls.push({ action, payload });
      return { action, payload };
    },
  },
};

const {
  ensureBrowserAutomationServer,
  resolveBrowserRuntimeLaunch,
  stopBrowserAutomationServer,
} = require('./browserAutomationHost.cjs');

afterEach(() => {
  calls.length = 0;
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
