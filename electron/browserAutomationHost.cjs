/**
 * Private loopback transport for Abu's bundled browser MCP server.
 *
 * The MCP process is deliberately unprivileged: it receives only a random
 * localhost endpoint and a per-process bearer token. Browser ownership stays
 * in Electron main, where WebContentsView isolation and lifecycle are already
 * enforced. No fixed port, discovery endpoint, CORS surface, or renderer token
 * is exposed.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { resourceRoot, REPO_ROOT } = require('./appEnv.cjs');

const BROWSER_RUNTIME_COMMAND = 'abu-browser-runtime';
const MAX_REQUEST_BYTES = 1024 * 1024;

let server = null;
let startPromise = null;
let startingServer = null;
let rejectStartingServer = null;
let endpoint = '';
let authToken = '';

function runtimeServerPath(app) {
  return app && app.isPackaged
    ? path.join(resourceRoot(app), 'browser-runtime', 'server.mjs')
    : path.join(REPO_ROOT, 'electron', 'browser-runtime', 'dist', 'server.mjs');
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function authorized(req) {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const provided = Buffer.from(value.slice(7));
  const expected = Buffer.from(authToken);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('browser runtime request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || typeof parsed.action !== 'string') {
          throw new Error('browser runtime request must contain an action');
        }
        resolve({
          action: parsed.action,
          payload: parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {},
        });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Abort-to-main: cancel the in-flight browser action when the client
 * connection closes before a response was ever sent (the run was stopped).
 *
 * This listens on the RESPONSE's `close`, not the request's. Verified with a
 * raw TCP client: `req`'s `close` event fires immediately once the request
 * body has been fully read — while the socket is still open and long before
 * the response is written — so it fires on every ordinary request and cannot
 * distinguish "client vanished" from "client is just waiting for the reply."
 * `res`'s `close` only fires early (`res.writableEnded === false`) on a
 * genuine premature disconnect; on a normal round trip it fires once, after
 * `res.end()`, with `writableEnded === true`. That flag is therefore both
 * necessary and sufficient — no extra local "did we finish" flag needed.
 */
async function handleRequest(req, res) {
  if (req.method !== 'POST' || req.url !== '/action') {
    sendJson(res, 404, { success: false, error: 'Not found' });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);

  try {
    const { action, payload } = await readJsonBody(req);
    const { performBrowserAutomation } = require('./browserHost.cjs');
    const data = await performBrowserAutomation(action, payload, { signal: controller.signal });
    res.off('close', onClose);
    // A request whose client already disconnected has no socket left to
    // write a response to; writing anyway would throw from inside this
    // handler (e.g. ERR_STREAM_WRITE_AFTER_END).
    if (!res.writableEnded) sendJson(res, 200, { success: true, data });
  } catch (error) {
    res.off('close', onClose);
    if (!res.writableEnded) {
      sendJson(res, 200, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function ensureBrowserAutomationServer() {
  if (server && endpoint && authToken) {
    return Promise.resolve({ endpoint, token: authToken });
  }
  if (startPromise) return startPromise;

  authToken = crypto.randomBytes(32).toString('hex');
  const candidate = http.createServer((req, res) => {
    void handleRequest(req, res);
  });
  candidate.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  startPromise = new Promise((resolve, reject) => {
    startingServer = candidate;
    rejectStartingServer = reject;
    const fail = (error) => {
      try {
        candidate.close();
      } catch {
        /* already closed */
      }
      if (startingServer === candidate) {
        startingServer = null;
        rejectStartingServer = null;
        authToken = '';
        startPromise = null;
      }
      reject(error);
    };
    candidate.once('error', fail);
    candidate.listen(0, '127.0.0.1', () => {
      if (startingServer !== candidate) {
        try {
          candidate.close();
        } catch {
          /* cancelled before listen completed */
        }
        return;
      }
      candidate.off('error', fail);
      candidate.on('error', (error) => {
        console.warn(
          `[browserAutomationHost] loopback server error: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
      const address = candidate.address();
      if (!address || typeof address === 'string') {
        fail(new Error('browser runtime loopback address is unavailable'));
        return;
      }
      server = candidate;
      startingServer = null;
      rejectStartingServer = null;
      endpoint = `http://127.0.0.1:${address.port}/action`;
      const result = { endpoint, token: authToken };
      startPromise = null;
      resolve(result);
    });
  });

  return startPromise;
}

async function resolveBrowserRuntimeLaunch(app) {
  const script = runtimeServerPath(app);
  if (!fs.existsSync(script)) {
    throw new Error(
      `Bundled browser runtime is missing: ${script}. Run npm run build:electron-browser-runtime.`
    );
  }
  const credentials = await ensureBrowserAutomationServer();
  return {
    command: 'node',
    args: [script],
    env: {
      ABU_BROWSER_RUNTIME_ENDPOINT: credentials.endpoint,
      ABU_BROWSER_RUNTIME_TOKEN: credentials.token,
    },
  };
}

function stopBrowserAutomationServer() {
  const current = server;
  const pending = startingServer;
  const rejectPending = rejectStartingServer;
  server = null;
  startingServer = null;
  rejectStartingServer = null;
  startPromise = null;
  endpoint = '';
  authToken = '';
  if (pending) {
    try {
      pending.close();
    } catch {
      /* listen may not have completed */
    }
    if (rejectPending) {
      rejectPending(new Error('browser automation server start was cancelled'));
    }
  }
  if (current) {
    try {
      current.close();
      if (typeof current.closeAllConnections === 'function') current.closeAllConnections();
    } catch {
      /* already closed */
    }
  }
}

module.exports = {
  BROWSER_RUNTIME_COMMAND,
  ensureBrowserAutomationServer,
  resolveBrowserRuntimeLaunch,
  stopBrowserAutomationServer,
  runtimeServerPath,
};
