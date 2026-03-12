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
import type { BridgeRequest, BridgeResponse } from './types.js';
import { PKG_VERSION } from './version.js';

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
 * GET /status → { wsPort, pid, extensionConnected, uptime, version, token }
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
          wsPort: activePort,
          pid: process.pid,
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
        console.error(`[abu-bridge] Discovery port ${DISCOVERY_PORT} in use — old bridge still running?`);
        // Not fatal — extension can still fall back to fixed port
        resolve();
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
 * Send a request to the Chrome Extension and wait for response.
 */
export function sendToExtension(
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs: number = 30_000
): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      reject(new Error(
        'Chrome Extension is not connected. Please install and enable the Abu Browser Extension, then check the connection status in the extension popup.'
      ));
      return;
    }

    const id = generateId();
    const request: BridgeRequest = { id, action, payload };

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out after ${timeoutMs}ms (action: ${action})`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });

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
