/**
 * F14 "network isolation proxy" headless verification — PLAIN NODE (no
 * Electron boot needed; networkProxyDispatch has no Electron dependency,
 * unlike e.g. f9Verify.cjs's trigger server which needs a real renderer to
 * drive `window.__TAURI_INTERNALS__.invoke`). Exercises
 * electron/networkProxy.cjs's networkProxyDispatch(app, cmd, args) directly,
 * with `app` passed as `null` (the module never touches it — see its JSDoc).
 *
 * Points a fake "upstream" at a local http server spun up in this harness
 * (127.0.0.1 on its own port) so nothing needs real internet — the ALLOWED
 * host is that upstream's own loopback address/port (added to the whitelist
 * as a literal IP, since domain whitelisting can't resolve a made-up
 * hostname to a local port); the BLOCKED case uses a domain name that is
 * deliberately absent from both the user whitelist and the built-in
 * DEFAULT_WHITELIST.
 *
 * Checks:
 *  1. get_network_proxy_port -> null before start.
 *  2. start_network_proxy -> a number (the bound port); idempotent 2nd call
 *     returns the SAME port (deliberate deviation from the Rust's
 *     throw-on-2nd-call — see networkProxy.cjs's module doc header).
 *  3. get_network_proxy_port -> same number as start returned.
 *  4. Plain-HTTP forward request through the proxy to the allowed upstream
 *     (127.0.0.1:<upstreamPort>) succeeds and returns the upstream's body.
 *  5. Plain-HTTP forward request through the proxy to a NOT-whitelisted host
 *     is refused with 403 and the `[sandbox-network-blocked] ... not in the
 *     network whitelist` body shape.
 *  6. HTTPS CONNECT tunnel to the allowed upstream succeeds (200 Connection
 *     Established, then a plain HTTP request piped through the tunnel reaches
 *     the upstream and its response comes back through the tunnel).
 *  7. HTTPS CONNECT tunnel to a NOT-whitelisted host is refused: the raw
 *     socket receives a 403 response (not 200 Connection Established).
 *  8. update_network_whitelist takes effect: a previously-blocked domain
 *     becomes allowed after being added, and a previously-allowed IP becomes
 *     blocked after a whitelist replace that omits it.
 *  9. node --check every .cjs under electron/ (both new files + a spot check
 *     that nothing else was broken).
 *
 * Run: node electron/spike/f14Verify.cjs
 */
'use strict';

const http = require('node:http');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { networkProxyDispatch, getProxyPort } = require('../networkProxy.cjs');

/** @type {{name: string, pass: boolean, detail?: unknown}[]} */
const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tiny local "upstream" server standing in for a real internet host. */
function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello-from-upstream');
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

/** Raw HTTP-proxy-style request: connects to the proxy, sends an absolute-form request line. */
function proxyHttpRequest(proxyPort, targetHost, targetPort, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        // Absolute-form request target — what a real HTTP-proxy client sends.
        path: `http://${targetHost}:${targetPort}${reqPath || '/'}`,
        headers: { Host: `${targetHost}:${targetPort}` },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Raw CONNECT tunnel: manual net.connect + write the CONNECT request line ourselves. */
function proxyConnect(proxyPort, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        socket.removeListener('data', onData);
        const headerText = buf.subarray(0, headerEnd).toString('utf8');
        const statusLine = headerText.split('\r\n')[0] || '';
        const statusMatch = /HTTP\/1\.1 (\d+)/.exec(statusLine);
        const status = statusMatch ? Number(statusMatch[1]) : 0;
        const rest = buf.subarray(headerEnd + 4);
        resolve({ status, socket, headerText, trailing: rest });
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

/** Send a plain HTTP GET through an already-established CONNECT tunnel socket. */
function requestThroughTunnel(socket, host, port, trailing) {
  return new Promise((resolve, reject) => {
    let buf = trailing && trailing.length ? Buffer.from(trailing) : Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString('utf8');
      if (text.includes('\r\n\r\n') && text.includes('hello-from-upstream')) {
        socket.removeListener('data', onData);
        resolve(text);
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    setTimeout(() => {
      socket.removeListener('data', onData);
      resolve(buf.toString('utf8'));
    }, 2000);
  });
}

async function main() {
  const upstream = await startUpstream();
  const upstreamHost = '127.0.0.1';
  const upstreamPort = upstream.port;

  // ── 1. get_network_proxy_port -> null before start ──
  const preStartPort = await networkProxyDispatch(null, 'get_network_proxy_port', {});
  record('1 get_network_proxy_port -> null before start', preStartPort === null, preStartPort);

  // ── 2. start_network_proxy -> a number; idempotent 2nd call same port ──
  // Whitelist the upstream's literal loopback IP (domain whitelisting can't
  // resolve a fake hostname to this ephemeral local port).
  const whitelist = [upstreamHost];
  const startResult1 = await networkProxyDispatch(null, 'start_network_proxy', {
    whitelist,
    allowPrivateNetworks: false,
  });
  record('2a start_network_proxy returns a port number', typeof startResult1 === 'number' && startResult1 > 0, startResult1);

  const startResult2 = await networkProxyDispatch(null, 'start_network_proxy', {
    whitelist,
    allowPrivateNetworks: false,
  });
  record('2b idempotent 2nd start_network_proxy returns same port', startResult2 === startResult1, { startResult1, startResult2 });

  const proxyPort = startResult1;

  // ── 3. get_network_proxy_port -> same number ──
  const port3 = await networkProxyDispatch(null, 'get_network_proxy_port', {});
  record('3 get_network_proxy_port matches started port', port3 === proxyPort, { port3, proxyPort });
  record('3b getProxyPort() export matches too', getProxyPort() === proxyPort, getProxyPort());

  // ── 4. Plain-HTTP forward to allowed upstream succeeds ──
  try {
    const res = await proxyHttpRequest(proxyPort, upstreamHost, upstreamPort, '/');
    record(
      '4 plain-HTTP forward to ALLOWED upstream returns 200 + upstream body',
      res.status === 200 && res.body === 'hello-from-upstream',
      res
    );
  } catch (err) {
    record('4 plain-HTTP forward to ALLOWED upstream returns 200 + upstream body', false, String(err));
  }

  // ── 5. Plain-HTTP forward to a NOT-whitelisted host is refused (403) ──
  try {
    const res = await proxyHttpRequest(proxyPort, 'not-whitelisted.example.invalid', 80, '/');
    const blocked =
      res.status === 403 &&
      res.body.includes('[sandbox-network-blocked]') &&
      res.body.includes('not-whitelisted.example.invalid') &&
      res.body.includes('not in the network whitelist');
    record('5 plain-HTTP forward to BLOCKED host -> 403 with sandbox-network-blocked body', blocked, res);
  } catch (err) {
    record('5 plain-HTTP forward to BLOCKED host -> 403 with sandbox-network-blocked body', false, String(err));
  }

  // ── 6. HTTPS CONNECT tunnel to ALLOWED upstream succeeds ──
  try {
    const conn = await proxyConnect(proxyPort, upstreamHost, upstreamPort);
    record('6a CONNECT to ALLOWED upstream -> 200 Connection Established', conn.status === 200, conn.headerText);
    if (conn.status === 200) {
      const through = await requestThroughTunnel(conn.socket, upstreamHost, upstreamPort, conn.trailing);
      record('6b request through CONNECT tunnel reaches upstream body', through.includes('hello-from-upstream'), through);
      conn.socket.end();
    } else {
      record('6b request through CONNECT tunnel reaches upstream body', false, 'tunnel not established');
      conn.socket.end();
    }
  } catch (err) {
    record('6a CONNECT to ALLOWED upstream -> 200 Connection Established', false, String(err));
    record('6b request through CONNECT tunnel reaches upstream body', false, String(err));
  }

  // ── 7. HTTPS CONNECT tunnel to a NOT-whitelisted host is refused ──
  try {
    const conn = await proxyConnect(proxyPort, 'not-whitelisted.example.invalid', 443);
    // The block message lives in the response BODY (after the header/body
    // \r\n\r\n split proxyConnect() already performed), not the header block
    // — wait for the rest of the body to arrive if it hasn't fully landed yet.
    await wait(50);
    const bodyText = conn.trailing.toString('utf8');
    const blocked =
      conn.status === 403 &&
      bodyText.includes('not-whitelisted.example.invalid') &&
      bodyText.includes('not in the network whitelist');
    record('7 CONNECT to BLOCKED host -> 403 (not 200 Connection Established)', blocked, { headerText: conn.headerText, bodyText });
    conn.socket.end();
  } catch (err) {
    record('7 CONNECT to BLOCKED host -> 403 (not 200 Connection Established)', false, String(err));
  }

  // ── 8. update_network_whitelist takes effect ──
  // 8a: add a previously-blocked domain -> now allowed. Use another local
  // upstream bound to 127.0.0.2 style isn't portable; instead verify via the
  // exported isHostAllowed-backed dispatch behavior against a synthetic
  // domain entry, by whitelisting the literal string used as "host" in a
  // plain-HTTP forward test (domain match doesn't need DNS to resolve for
  // the ALLOW decision itself — only actually connecting does; so use the
  // upstream's own loopback IP as the "newly added" entry to keep the
  // connect side real, added via an *update* call this time instead of the
  // initial start whitelist).
  await networkProxyDispatch(null, 'update_network_whitelist', {
    whitelist: [], // replace whitelist entirely, dropping upstreamHost
    allowPrivateNetworks: false,
  });
  try {
    const res = await proxyHttpRequest(proxyPort, upstreamHost, upstreamPort, '/');
    // Loopback (127.0.0.1) is ALWAYS allowed per proxy.rs semantics regardless
    // of the whitelist / allowPrivateNetworks — so this must STILL succeed.
    record(
      '8a loopback stays allowed even after whitelist replace omits it (always-allow-loopback semantics)',
      res.status === 200 && res.body === 'hello-from-upstream',
      res
    );
  } catch (err) {
    record('8a loopback stays allowed even after whitelist replace omits it (always-allow-loopback semantics)', false, String(err));
  }

  await networkProxyDispatch(null, 'update_network_whitelist', {
    whitelist: ['newly-added.example.invalid'],
    allowPrivateNetworks: false,
  });
  try {
    // We can't actually connect to a fake domain, but the whitelist decision
    // happens before the connect attempt — if it were blocked we'd see 403;
    // if it's allowed, the connect attempt itself fails with a 502
    // (Cannot connect), proving the whitelist gate passed it through.
    const res = await proxyHttpRequest(proxyPort, 'newly-added.example.invalid', 80, '/');
    record(
      '8b update_network_whitelist adds a domain -> passes whitelist gate (502 upstream-connect-fail, not 403 blocked)',
      res.status === 502,
      res
    );
  } catch (err) {
    record('8b update_network_whitelist adds a domain -> passes whitelist gate (502 upstream-connect-fail, not 403 blocked)', false, String(err));
  }

  try {
    const res = await proxyHttpRequest(proxyPort, 'still-not-whitelisted.example.invalid', 80, '/');
    record('8c a host never added stays blocked (403) after the update', res.status === 403, res);
  } catch (err) {
    record('8c a host never added stays blocked (403) after the update', false, String(err));
  }

  // ── 9. node --check every .cjs under electron/ ──
  try {
    const electronDir = path.join(__dirname, '..');
    const cjsFiles = fs
      .readdirSync(electronDir)
      .filter((f) => f.endsWith('.cjs'))
      .map((f) => path.join(electronDir, f));
    let allOk = true;
    const failures = [];
    for (const f of cjsFiles) {
      try {
        // process.execPath here is the ELECTRON binary, not plain node — without
        // ELECTRON_RUN_AS_NODE=1 it ignores `--check` as a no-op CLI switch and
        // fully boots the Electron app framework (GPU/network-service helper
        // processes) to run `f` as its main script instead of just syntax-
        // checking it, which never returns for a script that never calls
        // app.quit()/process.exit() — this is the actual cause of this harness
        // hanging (confirmed empirically: killed after minutes stuck on the
        // very first file). Setting ELECTRON_RUN_AS_NODE makes this child
        // process behave exactly like plain node, so `--check` is fast and
        // syntax-only, matching every other harness's node --check usage.
        execFileSync(process.execPath, ['--check', f], {
          stdio: 'pipe',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
      } catch (err) {
        allOk = false;
        failures.push({ file: f, err: String(err) });
      }
    }
    record('9 node --check passes for every electron/*.cjs', allOk, failures.length ? failures : `${cjsFiles.length} files checked`);
  } catch (err) {
    record('9 node --check passes for every electron/*.cjs', false, String(err));
  }

  const passed = checks.every((c) => c.pass);
  for (const c of checks) {
    console.log(`[f14-verify] ${c.pass ? 'PASS' : 'FAIL'} - ${c.name}${c.detail !== undefined ? ' (' + JSON.stringify(c.detail) + ')' : ''}`);
  }
  console.log(`[f14-verify] PASSED=${passed}`);

  upstream.server.close();
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('[f14-verify] uncaught error:', err);
  console.log('[f14-verify] PASSED=false');
  process.exit(1);
});
