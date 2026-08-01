/**
 * Real Electron verification for the zero-config in-app browser runtime.
 * Exercises production WebContentsView/session code against a random local
 * HTTP fixture; no Chrome installation, extension, or external network is
 * involved.
 */
'use strict';

const { app, BrowserWindow, nativeImage, session, webContents } = require('electron');
const http = require('node:http');
const path = require('node:path');

const { registerTauriHost, wireWindowEvents } = require('../tauriHost.cjs');
const { registerPrivilegedWindow } = require('../securityBoundary.cjs');
const {
  browserDispatch,
  closeAllBrowserViews,
  performBrowserAutomation,
} = require('../browserHost.cjs');
const { mcpDispatch } = require('../mcpBridge.cjs');

const checks = [];
const record = (name, pass, detail) => checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('uncaughtException', (error) => {
  console.error('[browser-runtime-verify] uncaught exception:', error);
  app.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error('[browser-runtime-verify] unhandled rejection:', error);
  app.exit(1);
});

function fixtureServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html>
        <head><title>Abu Browser Runtime Fixture</title></head>
        <body style="min-height:2200px">
          <label>Name <input id="name" placeholder="Your name"></label>
          <button id="submit" onclick="document.querySelector('#output').textContent='Hello '+document.querySelector('#name').value">Submit</button>
          <div id="output">Waiting</div>
        </body>
      </html>`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/fixture`,
      });
    });
  });
}

async function waitForPage(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
    if (contents && !contents.isLoading()) return contents;
    await wait(100);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function listenInRenderer(win, event, stashKey) {
  await win.webContents.executeJavaScript(`
    (async () => {
      globalThis[${JSON.stringify(stashKey)}] = [];
      const callbackId = window.__TAURI_INTERNALS__.transformCallback((entry) => {
        globalThis[${JSON.stringify(stashKey)}].push(entry.payload);
      });
      await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
        event: ${JSON.stringify(event)},
        target: { kind: 'Any' },
        handler: callbackId,
      });
    })()
  `);
}

async function waitForRpcResponse(win, stashKey, requestId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const lines = await win.webContents.executeJavaScript(
      `globalThis[${JSON.stringify(stashKey)}] || []`,
    );
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (message.id === requestId) return message;
      } catch {
        /* stderr and malformed lines are verified elsewhere */
      }
    }
    await wait(50);
  }
  throw new Error(`timed out waiting for MCP response ${String(requestId)}`);
}

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  let fixture;
  let win;
  let mcpId;
  try {
    fixture = await fixtureServer();
    registerTauriHost(app);

    win = new BrowserWindow({
      show: true,
      width: 1000,
      height: 800,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    wireWindowEvents(win);
    registerPrivilegedWindow(
      win,
      path.join(__dirname, '..', 'renderer', 'index.html'),
      { label: 'browser-runtime-verify' },
    );
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    const viewId = `browser-runtime-${Date.now()}`;
    browserDispatch(app, 'browser_create', {
      id: viewId,
      url: fixture.url,
      x: 0,
      y: 0,
      width: 900,
      height: 700,
    });
    const pageContents = await waitForPage(fixture.url);

    record(
      'isolated_persistent_session',
      pageContents.session === session.fromPartition('persist:abu-browser'),
    );
    record(
      'untrusted_page_has_no_node_or_runtime_marker',
      await pageContents.executeJavaScript(
        'typeof process === "undefined" && typeof globalThis.__ABU_ELECTRON_BROWSER_RUNTIME__ === "undefined"',
      ),
    );
    const notificationPermission = await pageContents.executeJavaScript(
      'Notification.requestPermission()',
    );
    record(
      'browser_session_denies_ambient_site_permissions',
      notificationPermission === 'denied',
      notificationPermission,
    );

    const tabs = await performBrowserAutomation('get_tabs');
    const tabId = tabs.summary.currentTabId;
    record(
      'get_tabs_finds_in_app_view',
      Number.isInteger(tabId) && tabs.summary.currentTabUrl === fixture.url,
      tabs.summary,
    );

    const snapshot = await performBrowserAutomation('snapshot', { tabId });
    record(
      'snapshot_returns_interactive_elements',
      snapshot.elements.some((element) => element.ref && element.tag === 'input') &&
        snapshot.elements.some((element) => element.ref && element.tag === 'button'),
      snapshot,
    );

    await performBrowserAutomation('fill', {
      tabId,
      locator: { css: '#name' },
      value: 'Abu',
    });
    await performBrowserAutomation('click', {
      tabId,
      locator: { css: '#submit' },
    });
    const output = await performBrowserAutomation('extract_text', {
      tabId,
      selector: '#output',
    });
    record('fill_click_extract_round_trip', output === 'Hello Abu', output);

    const jsResult = await performBrowserAutomation('execute_js', {
      tabId,
      code: 'document.querySelector("#name").value',
    });
    record('execute_js_runs_in_page_world', jsResult === 'Abu', jsResult);

    const screenshot = await performBrowserAutomation('screenshot', { tabId });
    record(
      'visible_screenshot_is_png',
      typeof screenshot === 'string' &&
        screenshot.startsWith('data:image/png;base64,') &&
        screenshot.length > 1000,
      screenshot.length,
    );

    const fullScreenshot = await performBrowserAutomation('screenshot_full_page', { tabId });
    const visibleSize = nativeImage.createFromDataURL(screenshot).getSize();
    const fullSize = nativeImage.createFromDataURL(fullScreenshot).getSize();
    record(
      'full_page_screenshot_is_png',
      typeof fullScreenshot === 'string' &&
        fullScreenshot.startsWith('data:image/png;base64,') &&
        fullSize.height > visibleSize.height,
      { visible: visibleSize, full: fullSize },
    );

    let rejectedFileUrl = false;
    try {
      await performBrowserAutomation('navigate', {
        tabId,
        action: 'goto',
        url: 'file:///tmp/not-allowed.html',
      });
    } catch (error) {
      rejectedFileUrl = /Only http: and https:/.test(String(error));
    }
    record('automation_navigation_rejects_file_scheme', rejectedFileUrl);

    await pageContents.loadURL(
      'data:text/html;charset=utf-8,<title>Restricted Browser Document</title><p>private</p>',
    );
    let rejectedRestrictedDocument = false;
    try {
      await performBrowserAutomation('execute_js', {
        tabId,
        code: 'document.body.textContent',
      });
    } catch (error) {
      rejectedRestrictedDocument = /only operate on http: and https:/.test(String(error));
    }
    record(
      'automation_rejects_non_web_document_contents',
      rejectedRestrictedDocument,
    );
    const restrictedTabs = await performBrowserAutomation('get_tabs');
    const restrictedTabsJson = JSON.stringify(restrictedTabs);
    record(
      'get_tabs_redacts_non_web_document_metadata',
      !restrictedTabsJson.includes('Restricted Browser Document') &&
        !restrictedTabsJson.includes('private') &&
        !restrictedTabsJson.includes('data:text') &&
        !restrictedTabsJson.includes(`"tabId":${tabId}`),
      restrictedTabs,
    );
    await pageContents.loadURL(fixture.url);

    // Full production chain: renderer event bridge -> mcpBridge -> native
    // sandbox launcher -> bundled Node -> bundled MCP server -> authenticated
    // random loopback -> browserHost -> response back over stdio.
    mcpId = `browser-runtime-mcp-${Date.now()}`;
    const stashKey = 'abuBrowserRuntimeMcpLines';
    await listenInRenderer(win, `mcp-msg-${mcpId}`, stashKey);
    await mcpDispatch(app, 'mcp_spawn', {
      id: mcpId,
      command: 'abu-browser-runtime',
      args: [],
      env: {},
    });
    await mcpDispatch(app, 'mcp_write', {
      id: mcpId,
      message: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'abu-browser-runtime-verify', version: '0.0.0' },
        },
      }),
    });
    const initialized = await waitForRpcResponse(win, stashKey, 1);
    await mcpDispatch(app, 'mcp_write', {
      id: mcpId,
      message: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }),
    });
    await mcpDispatch(app, 'mcp_write', {
      id: mcpId,
      message: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_tabs', arguments: {} },
      }),
    });
    const getTabsResponse = await waitForRpcResponse(win, stashKey, 2);
    const responseText = getTabsResponse.result?.content?.[0]?.text || '';
    record(
      'bundled_mcp_full_chain_get_tabs',
      !initialized.error &&
        !getTabsResponse.error &&
        responseText.includes('Abu Browser Runtime Fixture'),
      { initialized, getTabsResponse },
    );
    mcpDispatch(app, 'mcp_kill', { id: mcpId });
    mcpId = null;

    browserDispatch(app, 'browser_close', { id: viewId });
  } catch (error) {
    record('harness_completed', false, error instanceof Error ? error.stack : String(error));
  } finally {
    if (mcpId) mcpDispatch(app, 'mcp_kill', { id: mcpId });
    closeAllBrowserViews();
    if (fixture) await new Promise((resolve) => fixture.server.close(resolve));
    if (win && !win.isDestroyed()) win.destroy();
  }

  const ok = checks.every((check) => check.pass);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
