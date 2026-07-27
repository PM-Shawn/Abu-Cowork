/* plugin:http verify — drives the exact tauriFetch.ts protocol (fetch → rid,
 * fetch_send → {status,rid}, fetch_read_body loop with trailing signal byte)
 * from a renderer through tauriHost → httpHost → real Node fetch, against a
 * local server. Proves 验证连接 / webTools / mediaTools http now works. */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const http = require('node:http');
const { registerTauriHost } = require('../tauriHost.cjs');
const { registerPrivilegedWindow } = require('../securityBoundary.cjs');

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  // Local server: echoes a known body + reports POST size/tail. The large POST
  // proves the production number[] body is byte-counted rather than consuming
  // one generic IPC node per byte.
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.writeHead(200, { 'x-test': 'ok' });
        res.end(`POST:${Buffer.byteLength(b)}:${b.slice(-8)}`);
      });
    } else {
      res.writeHead(201, { 'content-type': 'text/plain', 'x-test': 'ok' });
      res.end('hello-http-body');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  registerTauriHost(app);
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, sandbox: true } });
  const page = path.join(__dirname, '..', 'renderer', 'index.html');
  registerPrivilegedWindow(win, page, { label: 'verify-http' });
  await win.loadFile(page);

  const out = await win.webContents.executeJavaScript(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    async function fetchLike(url, method, bodyStr) {
      const headers = [['content-type','text/plain']];
      const data = bodyStr ? Array.from(new TextEncoder().encode(bodyStr)) : null;
      const rid = await invoke('plugin:http|fetch', { clientConfig: { method, url, headers, data } });
      const meta = await invoke('plugin:http|fetch_send', { rid });
      let body = '';
      for (let i = 0; i < 10000; i++) {
        const chunk = await invoke('plugin:http|fetch_read_body', { rid: meta.rid });
        const u8 = new Uint8Array(chunk);
        const last = u8[u8.length - 1];
        body += new TextDecoder().decode(u8.slice(0, u8.length - 1));
        if (last === 1) break;
      }
      return { status: meta.status, statusText: meta.statusText, headers: meta.headers, body };
    }
    const r = {};
    const largeBody = 'x'.repeat(128 * 1024) + 'tail-128';
    try { r.get = await fetchLike(${JSON.stringify(base)}, 'GET'); } catch (e) { r.getErr = String(e); }
    try { r.post = await fetchLike(${JSON.stringify(base)}, 'POST', 'ping123'); } catch (e) { r.postErr = String(e); }
    try { r.largePost = await fetchLike(${JSON.stringify(base)}, 'POST', largeBody); } catch (e) { r.largePostErr = String(e); }
    return r;
  })()`);

  const g = out.get || {};
  const p = out.post || {};
  const lp = out.largePost || {};
  const passed =
    g.status === 201 && g.body === 'hello-http-body' &&
    g.headers && g.headers.some(([k, v]) => k === 'x-test' && v === 'ok') &&
    p.status === 200 && p.body === 'POST:7:ping123' &&
    lp.status === 200 && lp.body === 'POST:131080:tail-128';

  console.log('[http-verify] ' + JSON.stringify(out).slice(0, 400));
  console.log('[http-verify] PASSED=' + passed);
  server.close();
  app.exit(passed ? 0 : 1);
});
