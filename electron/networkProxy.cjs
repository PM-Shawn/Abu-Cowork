/**
 * Electron main-side network-isolation proxy (Phase 2 slice F14), porting
 * src-tauri/src/proxy.rs's raw-TcpListener HTTP/CONNECT forward proxy to a
 * plain Node `http` server. Backs `start_network_proxy` /
 * `update_network_whitelist` / `get_network_proxy_port` — the three custom
 * commands the frontend's sandbox config (src/core/sandbox/config.ts, ~line
 * 35/51) invokes to gate outbound network access for sandboxed shell
 * commands (see electron/commandHost.cjs's `proxyEnvVars()` — it points
 * HTTP_PROXY/HTTPS_PROXY at whatever port this module is listening on).
 *
 * Argument-name contract (verified against src/core/sandbox/config.ts:35-38,
 * 51-54 — the actual invoke() call sites, not the Rust parameter names):
 * Tauri's `invoke()` auto-converts camelCase JS keys to the snake_case Rust
 * parameter names (`allowPrivateNetworks` -> `allow_private_networks`);
 * Electron's raw IPC does no such conversion. So this dispatcher reads the
 * CAMELCASE keys the frontend actually sends (`whitelist`,
 * `allowPrivateNetworks`) — matching, byte for byte, what reaches the Rust
 * side today.
 *
 * ## Whitelist match semantics (ported line-for-line from proxy.rs's
 * `is_host_allowed` / `parse_entry` / `build_config`)
 * - Exact domain: `"github.com"` matches only `github.com` (case-insensitive).
 * - Wildcard: `"*.company.com"` matches `company.com` itself AND any
 *   subdomain (`api.company.com`, `deep.sub.company.com`) — NOT other
 *   `*company.com` look-alikes (`notcompany.com` is rejected).
 * - CIDR (IPv4 only): `"10.0.0.0/8"` matches literal IPv4 targets in range.
 * - `allowPrivateNetworks`: when true, RFC1918 ranges (10/8, 172.16/12,
 *   192.168/16) plus 127/8 are allowed for literal-IP targets, AND for
 *   *domain* targets whose DNS resolution lands in a private/loopback range
 *   (Rust does this via a blocking `to_socket_addrs()`; here via
 *   `dns.promises.lookup` since Node has no sync resolver).
 * - Loopback (127.0.0.0/8, `::1`) is ALWAYS allowed for literal-IP targets,
 *   independent of `allowPrivateNetworks` (mirrors proxy.rs's unconditional
 *   `if ip.is_loopback() { return true }` after the gated private-network
 *   check).
 * - A built-in DEFAULT_WHITELIST (package registries, code hosting, LLM
 *   APIs, common CDNs) is always merged ahead of the user-supplied list.
 *
 * ## Block response (ported from proxy.rs's `send_error`)
 * `403 Forbidden`, no `Content-Type` header, body
 * `<html><body><h1>403 Forbidden</h1><p>[sandbox-network-blocked] {host} is
 * not in the network whitelist</p></body></html>` — for CONNECT tunnels this
 * is written directly to the raw socket (before any `200 Connection
 * Established` is sent); for plain HTTP it's the normal proxy response.
 *
 * ## HTTPS CONNECT tunneling
 * Supported (proxy.rs's `handle_connect` does raw bidirectional TCP piping
 * for CONNECT) — required for real usage since most sandboxed tool traffic
 * (git, npm, pip, curl) goes over HTTPS via CONNECT once HTTPS_PROXY is set.
 * Node's `http.Server` never fires `'request'` for CONNECT; it fires
 * `'connect'` with the raw duplex socket, which is used here for the tunnel
 * (whitelist-check the target host, then either refuse with the 403 shape
 * above or reply `200 Connection Established` and pipe both directions).
 *
 * ## Deliberate DEVIATION from the Rust source (documented, matches the
 * project's existing precedent in triggerServer.cjs's module doc header):
 * - `start_network_proxy` here is idempotent (returns the already-bound
 *   port on a second call) instead of throwing `"Proxy already running"`.
 *   The frontend's `initNetworkProxy()` (config.ts) already guards
 *   double-invocation with its own `proxyStarted` module flag and only
 *   catches-and-logs on rejection, so this is a strictly more permissive
 *   behavior with no observable frontend difference.
 * - The plain-HTTP (non-CONNECT) forward path here forwards the full
 *   request (method + headers + body) to the upstream and streams its full
 *   response back. proxy.rs's `handle_http_forward` is naive: after
 *   whitelist-checking it *drains and discards* the original request's
 *   headers, then re-sends only the bare request line to the upstream (no
 *   Host header, no other headers, no body) before falling into the same
 *   bidirectional `io::copy` pipe as CONNECT. That quirk isn't reproduced
 *   here — proxying with Node's `http` module makes a fully-formed forward
 *   request unavoidable (Node has already parsed the headers off the wire
 *   by the time `'request'` fires; there's no raw-line access to discard),
 *   and it's a strictly more correct behavior for the (secondary — CONNECT
 *   is the primary path since HTTPS_PROXY drives virtually all real traffic)
 *   plain-HTTP forward case. The whitelist gate and the 403 block response
 *   shape — the two things the task brief calls out to match exactly — are
 *   ported faithfully in both paths.
 *
 * Wired from electron/tauriHost.cjs via networkProxyDispatch(app, cmd, args)
 * — args is the args object directly (mirrors commandDispatch/
 * triggerDispatch's convention), placed after triggerDispatch and before
 * windowDispatch in the dispatch chain (see the wiring comment there).
 */
'use strict';

const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');

/** Sentinel returned when `cmd` isn't a network-proxy command. */
const NETWORK_PROXY_MISS = Symbol('network-proxy-miss');

/** Reason phrases used by both the plain-HTTP and raw-socket (CONNECT) error paths. */
const REASON_PHRASES = { 400: 'Bad Request', 403: 'Forbidden', 502: 'Bad Gateway' };

// Mirrors proxy.rs's DEFAULT_WHITELIST exactly (package registries, code
// hosting, LLM APIs, common CDNs) — always merged ahead of user entries.
const DEFAULT_WHITELIST = [
  // Package registries
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'registry.npmmirror.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'rubygems.org',
  // Code hosting
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'gitlab.com',
  '*.gitlab.com',
  'bitbucket.org',
  // LLM APIs
  'api.anthropic.com',
  'api.openai.com',
  'api.deepseek.com',
  // Common CDNs
  'cdn.jsdelivr.net',
  'unpkg.com',
];

// ─── Module state ──────────────────────────────────────────────────────────
/** @type {{ server: import('node:http').Server, port: number } | null} */
let serverState = null;
/** @type {Promise<number> | null} */
let startPromise = null;
/** @type {{ entries: Array<{type: 'domain'|'wildcard', domain: string} | {type: 'cidr', network: number, mask: number}>, allowPrivateNetworks: boolean }} */
let whitelistConfig = { entries: [], allowPrivateNetworks: false };

// ─── Whitelist config parsing (ports proxy.rs's build_config/parse_entry) ──

/**
 * @param {number} bits
 * @returns {number} 32-bit unsigned mask, matching Rust's `!0u32 << (32-bits)`
 *   with the explicit bits===0 special case (JS `<<` masks its shift amount
 *   to 0-31, so `x << 32` would wrongly behave like `x << 0` without this).
 */
function cidrMask(bits) {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

/** @param {string} ip dotted-quad IPv4 literal, already validated by caller. */
function ipv4ToUint32(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** @param {string} sRaw */
function parseEntry(sRaw) {
  const s = sRaw.trim().toLowerCase();

  // CIDR: "10.0.0.0/8"
  const slashIdx = s.indexOf('/');
  if (slashIdx !== -1) {
    const ipStr = s.slice(0, slashIdx);
    const bits = Number(s.slice(slashIdx + 1));
    if (net.isIPv4(ipStr) && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
      const mask = cidrMask(bits);
      const network = (ipv4ToUint32(ipStr) & mask) >>> 0;
      return { type: 'cidr', network, mask };
    }
  }

  // Wildcard: "*.foo.com"
  if (s.startsWith('*.')) {
    return { type: 'wildcard', domain: s.slice(2) };
  }

  // Exact domain or IP
  return { type: 'domain', domain: s };
}

/**
 * @param {string[]} userEntries
 * @param {boolean} allowPrivateNetworks
 */
function buildConfig(userEntries, allowPrivateNetworks) {
  const entries = [];
  for (const d of DEFAULT_WHITELIST) entries.push(parseEntry(d));
  for (const raw of userEntries || []) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed && !trimmed.startsWith('#')) entries.push(parseEntry(trimmed));
  }
  return { entries, allowPrivateNetworks: !!allowPrivateNetworks };
}

// ─── Whitelist matching (ports proxy.rs's is_host_allowed/is_private_ip) ───

/** @param {string} ip */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const octets = ip.split('.').map(Number);
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      octets[0] === 127
    );
  }
  if (net.isIPv6(ip)) return ip === '::1';
  return false;
}

/** @param {string} ip */
function isLoopbackIp(ip) {
  if (net.isIPv4(ip)) return ip.split('.')[0] === '127';
  if (net.isIPv6(ip)) return ip === '::1';
  return false;
}

/**
 * @param {string} hostRaw
 * @param {typeof whitelistConfig} config
 * @returns {Promise<boolean>}
 */
async function isHostAllowed(hostRaw, config) {
  const host = (hostRaw || '').toLowerCase();
  if (!host) return false;

  if (net.isIP(host)) {
    if (config.allowPrivateNetworks && isPrivateIp(host)) return true;
    // Loopback is always allowed, independent of allowPrivateNetworks —
    // mirrors proxy.rs's unconditional `if ip.is_loopback()` check.
    if (isLoopbackIp(host)) return true;
    if (net.isIPv4(host)) {
      const ipNum = ipv4ToUint32(host);
      for (const e of config.entries) {
        if (e.type === 'cidr' && (ipNum & e.mask) >>> 0 === e.network) return true;
      }
    }
    return false;
  }

  for (const e of config.entries) {
    if (e.type === 'domain' && host === e.domain) return true;
    if (e.type === 'wildcard' && (host === e.domain || host.endsWith(`.${e.domain}`))) return true;
  }

  // DNS-resolution fallback for domains landing in a private/loopback range
  // — only when allowPrivateNetworks is set (mirrors proxy.rs's gated
  // `to_socket_addrs()` branch). Node has no sync resolver, so this is async
  // (a documented behavioral difference in timing only, not outcome).
  if (config.allowPrivateNetworks) {
    try {
      const addrs = await dns.promises.lookup(host, { all: true });
      for (const a of addrs) {
        if (isPrivateIp(a.address) || isLoopbackIp(a.address)) return true;
      }
    } catch {
      /* DNS failure -> falls through to false, matches Rust's `if let Ok(addrs)` gate */
    }
  }

  return false;
}

// ─── HTTP error responses (ports proxy.rs's send_error, byte-for-byte shape) ──

/** @param {number} code @param {string} message */
function buildErrorBody(code, message) {
  const reason = REASON_PHRASES[code] || 'Error';
  return `<html><body><h1>${code} ${reason}</h1><p>${message}</p></body></html>`;
}

/** Used for the raw-socket (CONNECT) error path — no ServerResponse available there. */
function buildErrorResponse(code, message) {
  const reason = REASON_PHRASES[code] || 'Error';
  const body = buildErrorBody(code, message);
  return `HTTP/1.1 ${code} ${reason}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

/** @param {import('node:http').ServerResponse} res @param {number} code @param {string} message */
function sendError(res, code, message) {
  const reason = REASON_PHRASES[code] || 'Error';
  const body = buildErrorBody(code, message);
  try {
    // No Content-Type header — matches proxy.rs's send_error, which never sets one.
    res.writeHead(code, reason, { 'Content-Length': Buffer.byteLength(body), Connection: 'close' });
    res.end(body);
  } catch {
    try {
      res.end();
    } catch {
      /* best-effort */
    }
  }
}

// ─── Plain-HTTP forward path (server 'request' event) ─────────────────────

/**
 * Resolve the upstream {host, port, path} from a proxy request. Handles both
 * absolute-form targets (`GET http://host:port/path HTTP/1.1`, what real
 * HTTP-proxy clients send) and relative-form + Host header as a fallback.
 * @param {string} rawUrl
 * @param {string | undefined} hostHeader
 */
function resolveForwardTarget(rawUrl, hostHeader) {
  const schemeMatch = /^https?:\/\//i.exec(rawUrl);
  if (schemeMatch) {
    const withoutScheme = rawUrl.slice(schemeMatch[0].length);
    const slashIdx = withoutScheme.indexOf('/');
    const hostPort = slashIdx === -1 ? withoutScheme : withoutScheme.slice(0, slashIdx);
    const reqPath = slashIdx === -1 ? '/' : withoutScheme.slice(slashIdx);
    const colonIdx = hostPort.indexOf(':');
    const host = colonIdx === -1 ? hostPort : hostPort.slice(0, colonIdx);
    const port = colonIdx === -1 ? 80 : Number(hostPort.slice(colonIdx + 1)) || 80;
    if (!host) return null;
    return { host: host.toLowerCase(), port, path: reqPath || '/' };
  }
  if (hostHeader) {
    const colonIdx = hostHeader.indexOf(':');
    const host = colonIdx === -1 ? hostHeader : hostHeader.slice(0, colonIdx);
    const port = colonIdx === -1 ? 80 : Number(hostHeader.slice(colonIdx + 1)) || 80;
    if (!host) return null;
    return { host: host.toLowerCase(), port, path: rawUrl || '/' };
  }
  return null;
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
function requestListener(req, res) {
  const rawUrl = req.url || '';
  const target = resolveForwardTarget(rawUrl, req.headers.host);
  if (!target) {
    sendError(res, 400, 'Cannot determine target host');
    return;
  }

  isHostAllowed(target.host, whitelistConfig)
    .then((allowed) => {
      if (!allowed) {
        console.error(`[network-proxy] BLOCKED: ${target.host}`);
        sendError(res, 403, `[sandbox-network-blocked] ${target.host} is not in the network whitelist`);
        return;
      }

      const upstreamReq = http.request(
        { host: target.host, port: target.port, method: req.method, path: target.path, headers: req.headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        }
      );
      upstreamReq.on('error', (err) => {
        sendError(res, 502, `Cannot connect to ${target.host}:${target.port}: ${err.message}`);
      });
      req.pipe(upstreamReq);
    })
    .catch((err) => {
      sendError(res, 502, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
    });
}

// ─── HTTPS CONNECT tunneling (server 'connect' event) ──────────────────────

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 */
function connectListener(req, socket, head) {
  socket.on('error', () => {
    /* client dropped the tunnel; upstream side (if any) cleans up via its own handlers */
  });

  const target = req.url || ''; // "host:port"
  // Naive split on first ':' — matches proxy.rs's `target.split(':').next()`
  // (doesn't handle bracketed IPv6 literals; neither does the Rust source).
  const host = target.split(':')[0] || '';
  if (!host) {
    socket.end(buildErrorResponse(400, 'Cannot determine target host'));
    return;
  }

  isHostAllowed(host, whitelistConfig)
    .then((allowed) => {
      if (!allowed) {
        console.error(`[network-proxy] BLOCKED: ${host}`);
        socket.end(buildErrorResponse(403, `[sandbox-network-blocked] ${host} is not in the network whitelist`));
        return;
      }

      const portStr = target.split(':')[1];
      const port = portStr ? Number(portStr) : 443;
      const upstream = net.connect(port, host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', (err) => {
        try {
          socket.end(buildErrorResponse(502, `Cannot connect to ${target}: ${err.message}`));
        } catch {
          /* best-effort */
        }
      });
    })
    .catch((err) => {
      try {
        socket.end(buildErrorResponse(502, `Internal error: ${err instanceof Error ? err.message : String(err)}`));
      } catch {
        /* best-effort */
      }
    });
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Start the proxy lazily (idempotent — see module doc header's "Deliberate
 * DEVIATION" note). Binds 127.0.0.1:0 (OS-assigned port), mirroring
 * proxy.rs's `TcpListener::bind("127.0.0.1:0")`.
 * @param {string[]} userWhitelist
 * @param {boolean} allowPrivateNetworks
 * @returns {Promise<number>}
 */
function startProxy(userWhitelist, allowPrivateNetworks) {
  if (serverState) return Promise.resolve(serverState.port);
  if (startPromise) return startPromise;

  whitelistConfig = buildConfig(userWhitelist, allowPrivateNetworks);

  startPromise = new Promise((resolve, reject) => {
    const server = http.createServer(requestListener);
    server.on('connect', connectListener);
    server.on('error', (err) => {
      startPromise = null;
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      serverState = { server, port };
      console.log(`[network-proxy] listening on 127.0.0.1:${port}`);
      resolve(port);
    });
  });
  return startPromise;
}

/**
 * Update the whitelist at runtime. No-ops if the proxy was never started —
 * mirrors proxy.rs's `update_whitelist`, which only touches the `WHITELIST`
 * OnceLock if it was already `.set()` by a prior `start_proxy` call.
 * @param {string[]} userWhitelist
 * @param {boolean} allowPrivateNetworks
 */
function updateWhitelist(userWhitelist, allowPrivateNetworks) {
  if (!serverState) return;
  whitelistConfig = buildConfig(userWhitelist, allowPrivateNetworks);
}

/** @returns {number | null} */
function getProxyPort() {
  return serverState ? serverState.port : null;
}

// ─── Command dispatch ──────────────────────────────────────────────────────

/**
 * @param {import('electron').App} app unused — kept for signature parity with
 *   commandHost.cjs/triggerServer.cjs's dispatch(app, cmd, args) convention.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
async function networkProxyDispatch(app, cmd, args) {
  void app;
  const a = args || {};
  switch (cmd) {
    case 'start_network_proxy': {
      const whitelist = Array.isArray(a.whitelist) ? a.whitelist : [];
      const allowPrivateNetworks = !!a.allowPrivateNetworks;
      return await startProxy(whitelist, allowPrivateNetworks);
    }
    case 'update_network_whitelist': {
      const whitelist = Array.isArray(a.whitelist) ? a.whitelist : [];
      const allowPrivateNetworks = !!a.allowPrivateNetworks;
      updateWhitelist(whitelist, allowPrivateNetworks);
      return null;
    }
    case 'get_network_proxy_port':
      return getProxyPort();
    default:
      return NETWORK_PROXY_MISS;
  }
}

module.exports = {
  networkProxyDispatch,
  NETWORK_PROXY_MISS,
  // Exported for the headless verify harness (electron/spike/f14Verify.cjs)
  // and for future use by commandHost.cjs's getNetworkProxyPort() stub.
  startProxy,
  updateWhitelist,
  getProxyPort,
  isHostAllowed,
  buildConfig,
};
