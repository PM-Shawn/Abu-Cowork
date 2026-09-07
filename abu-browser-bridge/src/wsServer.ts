/**
 * WebSocket server that accepts connections from the Chrome Extension.
 * Routes requests from MCP tools to the extension and returns responses.
 *
 * Also exposes a lightweight HTTP discovery endpoint on a fixed port
 * so the Chrome Extension can reliably find the WS port.
 *
 * Security: Generates a random auth token on startup. The Chrome Extension
 * must fetch this token from the discovery endpoint and include it as
 * `Sec-WebSocket-Protocol` header when connecting.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server as HTTPServer } from 'http';
import { randomBytes } from 'crypto';
import type {
  BridgeCancelMessage,
  BridgeReleaseMessage,
  BridgeRequest,
  BridgeResponse,
} from './types.js';
import { PKG_VERSION } from './version.js';
import { linkAbortSignal } from './abortSignal.js';

const DEFAULT_WS_PORT = 9876;
const DISCOVERY_PORT = 9875;
const HEARTBEAT_INTERVAL = 15_000; // 15s

interface PendingRequest {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let wss: WebSocketServer | null = null;
let discoveryServer: HTTPServer | null = null;
let extensionSocket: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pongReceived = true;
const pendingRequests = new Map<string, PendingRequest>();
let requestCounter = 0;
let activePort: number | null = null;

// Auth token — generated once per bridge process, shared via discovery endpoint
const authToken = randomBytes(24).toString('hex');

function generateId(): string {
  const rand = randomBytes(4).toString('hex');
  return `req_${Date.now().toString(36)}_${(++requestCounter).toString(36)}_${rand}`;
}

// --- HTTP Discovery Endpoint ---

/**
 * Start the HTTP discovery server on a fixed well-known port.
 * Chrome Extension queries this to find the actual WS port and auth token.
 *
 * GET /status → { service, wsPort, pid, extensionConnected, uptime, version, token }
 *
 * CORS restricted to chrome-extension:// origins only.
 */
function startDiscoveryServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    discoveryServer = createServer((req, res) => {
      const origin = req.headers.origin ?? '';

      // Only allow chrome-extension:// and no-origin (direct fetch from extension background)
      const isAllowedOrigin = !origin || origin.startsWith('chrome-extension://');
      if (!isAllowedOrigin) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // CORS headers for allowed origins
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Vary', 'Origin');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/status' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: 'abu-browser-bridge',
          wsPort: activePort,
          pid: process.pid,
          parentPid: process.ppid,
          extensionConnected: isExtensionConnected(),
          uptime: Math.round((Date.now() - startTime) / 1000),
          version: PKG_VERSION,
          token: authToken,
        }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    discoveryServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Discovery port ${DISCOVERY_PORT} is already in use. ` +
          'Close the other Abu instance and retry.',
        ));
      } else {
        reject(err);
      }
    });

    discoveryServer.listen(DISCOVERY_PORT, '127.0.0.1', () => {
      console.error(`[abu-bridge] Discovery endpoint: http://127.0.0.1:${DISCOVERY_PORT}/status`);
      resolve();
    });
  });
}

// --- WebSocket Server ---

/**
 * Start the WebSocket server on a fixed port.
 * Validates auth token from Sec-WebSocket-Protocol header on connection.
 */
export async function startWSServer(port: number = DEFAULT_WS_PORT): Promise<number> {
  await startDiscoveryServer();
  await listenOnPort(port);
  activePort = port;
  return port;
}

function listenOnPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    wss = new WebSocketServer({
      port,
      host: '127.0.0.1',
      verifyClient: (info, callback) => {
        // Validate auth token from Sec-WebSocket-Protocol header
        const protocol = info.req.headers['sec-websocket-protocol'];
        if (protocol === authToken) {
          callback(true);
        } else {
          console.error(`[abu-bridge] Rejected WS connection: invalid auth token`);
          callback(false, 401, 'Unauthorized');
        }
      },
    });

    wss.on('listening', () => {
      console.error(`[abu-bridge] WS server listening on ws://127.0.0.1:${port}`);
      startHeartbeat();
      resolve();
    });

    wss.on('error', (err) => {
      console.error(`[abu-bridge] WS server error:`, err.message);
      reject(err);
    });

    wss.on('connection', (ws, req) => {
      const origin = req.headers.origin ?? 'unknown';
      console.error(`[abu-bridge] Extension connected (origin: ${origin})`);

      // Only allow one extension connection at a time
      if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
        console.error('[abu-bridge] Replacing existing extension connection');
        extensionSocket.close(1000, 'Replaced by new connection');
      }

      extensionSocket = ws;
      pongReceived = true;

      // Handle pong responses for heartbeat
      ws.on('pong', () => {
        pongReceived = true;
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as BridgeResponse;
          handleResponse(msg);
        } catch (err) {
          console.error('[abu-bridge] Invalid message from extension:', err);
        }
      });

      ws.on('close', (code, reason) => {
        console.error(`[abu-bridge] Extension disconnected (code: ${code}, reason: ${reason.toString()})`);
        if (extensionSocket === ws) {
          extensionSocket = null;
        }
        // Reject all pending requests
        for (const [id, pending] of pendingRequests) {
          pending.reject(new Error('Extension disconnected'));
          clearTimeout(pending.timer);
          pendingRequests.delete(id);
        }
      });

      ws.on('error', (err) => {
        console.error('[abu-bridge] Extension socket error:', err.message);
      });
    });
  });
}

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
      if (!pongReceived) {
        // No pong since last ping — connection is dead
        console.error('[abu-bridge] Extension not responding to heartbeat, closing connection');
        extensionSocket.terminate();
        extensionSocket = null;
        return;
      }
      pongReceived = false;
      extensionSocket.ping();
    }
  }, HEARTBEAT_INTERVAL);
}

function handleResponse(msg: BridgeResponse): void {
  const pending = pendingRequests.get(msg.id);
  if (!pending) {
    console.error(`[abu-bridge] Received response for unknown request: ${msg.id}`);
    return;
  }
  clearTimeout(pending.timer);
  pendingRequests.delete(msg.id);
  pending.resolve(msg);
}

/**
 * Tell the extension a run is done with the browser, so it drops the tab claims
 * that run holds (`abu-chrome-extension/src/background/tabClaims.ts`). `runId`
 * omitted ⇒ every run of the conversation, the same scope the built-in host's
 * `browser_dispose_owner {conversationId}` has.
 *
 * Fire-and-forget and best-effort, like the host's own dispose calls: a lost
 * release costs one stale claim (which the tab closing, or the socket dropping,
 * clears anyway), and no browser action may fail over bookkeeping.
 *
 * The ONLY caller is `runSettled.ts`, the handler for the app's run-settlement
 * MCP notification. Deliberately not the per-request abort path: the MCP SDK
 * aborts a handler for its own request timeouts too, so a still-running task
 * would lose its tabs (see the long note at the abort path below).
 *
 * A run's settlement always passes the run key (`runId ?? 'main'`): omitting it
 * releases EVERY run of the conversation, which the host never does there —
 * `disposeRunBrowserViews` returns early without a runKey, and the
 * conversation-wide scope belongs to conversation deletion alone. That is what
 * the omitted-`runId` shape is reserved for.
 */
export function releaseExtensionTabs(ownerId: unknown, runId?: unknown): void {
  if (typeof ownerId !== 'string' || ownerId.length === 0) return;
  if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) return;
  const release: BridgeReleaseMessage = {
    type: 'release',
    ownerId,
    ...(typeof runId === 'string' && runId.length > 0 ? { runId } : {}),
  };
  try {
    extensionSocket.send(JSON.stringify(release));
  } catch (err) {
    console.error('[abu-bridge] Failed to send release to extension:', err);
  }
}

/**
 * Send a request to the Chrome Extension and wait for response.
 *
 * `signal`, when given, lets the caller stop waiting before the extension
 * responds (e.g. the conversation run was stopped): the pending request is
 * dropped immediately, a best-effort `{type:'cancel', requestId}` message is
 * sent so the extension can stop working on it, and the promise rejects with
 * an `AbortError` instead of hanging until `timeoutMs`. If `signal` is
 * already aborted, the request is never sent at all.
 */
export function sendToExtension(
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs: number = 30_000,
  signal?: AbortSignal
): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      reject(new Error(
        'Chrome Extension is not connected. Please install and enable the Abu Browser Extension, then check the connection status in the extension popup.'
      ));
      return;
    }

    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    const id = generateId();
    const request: BridgeRequest = { id, action, payload };

    const unlink = linkAbortSignal(signal, () => {
      const pending = pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(id);
      }
      if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
        const cancel: BridgeCancelMessage = { type: 'cancel', requestId: id };
        try {
          extensionSocket.send(JSON.stringify(cancel));
        } catch (err) {
          console.error('[abu-bridge] Failed to send cancel to extension:', err);
        }
      }
      // Deliberately NOT a tab-claim release point, tempting as it looks.
      //
      // An abort here does NOT mean "this run stopped". The MCP SDK cancels a
      // request when its OWN timeout fires: the timeout handler calls
      // `cancel()` (`@modelcontextprotocol/sdk` `shared/protocol.js`), which
      // sends `notifications/cancelled`, which the server side answers by
      // aborting exactly the handler signal that reaches us here. And
      // `src/core/mcp/client.ts` passes a `timeout` on every `callTool` (120s
      // for the browser servers, less if the user configured it), so a slow
      // `screenshot_full_page` on a live run lands on this line.
      //
      // The bridge cannot tell the two apart: all it receives is an abort
      // whose `reason` is a string produced by whoever cancelled, so
      // positively recognising "the run stopped" would mean matching on
      // SDK-formatted text. Getting that wrong is SILENT and it fails open —
      // it hands a still-running task's tab to another conversation, the exact
      // thing the claims exist to prevent. An unreleased claim, by contrast,
      // costs another conversation one refusal that names its next step, and
      // costs the user nothing at all (their own use of the tab is unaffected).
      //
      // Claims are therefore dropped by the extension itself — the tab closing
      // and the socket dropping — plus the explicit `{type:'release'}`, which
      // the app sends once per run at its settlement seal over a notification
      // that says so unambiguously; see `runSettled.ts`.
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      unlink();
      reject(new Error(`Request timed out after ${timeoutMs}ms (action: ${action})`));
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve: (response) => {
        unlink();
        resolve(response);
      },
      reject: (error) => {
        unlink();
        reject(error);
      },
      timer,
    });

    extensionSocket.send(JSON.stringify(request));
  });
}

/**
 * Check if the Chrome Extension is currently connected.
 */
export function isExtensionConnected(): boolean {
  return extensionSocket !== null && extensionSocket.readyState === WebSocket.OPEN;
}

/**
 * Get the port the WS server is actually listening on.
 */
export function getActivePort(): number | null {
  return activePort;
}

export function stopWSServer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Server shutting down'));
    pendingRequests.delete(id);
  }
  if (extensionSocket) {
    extensionSocket.close(1000, 'Server shutting down');
    extensionSocket = null;
  }
  if (wss) {
    wss.close();
    wss = null;
  }
  if (discoveryServer) {
    discoveryServer.close();
    discoveryServer = null;
  }
  activePort = null;
}
