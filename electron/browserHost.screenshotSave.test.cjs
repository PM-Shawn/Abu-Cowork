'use strict';

/** Browser capture and destination preparation, with Electron at the boundary. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const electronId = require.resolve('electron');
const tauriHostId = require.resolve('./tauriHost.cjs');
const browserHostId = require.resolve('./browserHost.cjs');

const OWNER_A = 'conversation-a';

let nextContentsId = 900;
const contentsRegistry = new Map();

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1EAAAAASUVORK5CYII=';

class FakeDebugger {
  constructor() {
    this.attached = false;
    this.commands = [];
  }

  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  detach() { this.attached = false; }

  on() { return this; }

  async sendCommand(method, params) {
    this.commands.push({ method, params });
    if (method === 'Page.captureScreenshot') return { data: PNG_B64 };
    if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1280, height: 800 } };
    return {};
  }

  sent(method) { return this.commands.filter((c) => c.method === method); }
}

class FakeWebContents {
  constructor() {
    this.id = (nextContentsId += 1);
    contentsRegistry.set(this.id, this);
    this.url = 'about:blank';
    this.title = 'Blank';
    this.destroyed = false;
    this.listeners = new Map();
    this.navigationHistory = { goBack() {}, goForward() {} };
    this.debugger = new FakeDebugger();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return this;
  }

  once(event, handler) { return this.on(event, handler); }
  removeListener(event, handler) {
    this.listeners.set(event, (this.listeners.get(event) || []).filter((value) => value !== handler));
  }

  setWindowOpenHandler() {}
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  focus() {}
  stop() {}
  reload() {}
  close() {}
  getOSProcessId() { return 4242; }
  executeJavaScript() { return Promise.resolve(undefined); }
  getMainFrame() { return null; }
  async loadURL(url) { this.url = url; return undefined; }
}

class FakeWebContentsView {
  constructor() {
    this.webContents = new FakeWebContents();
    this.visible = true;
    this.bounds = null;
  }

  setBounds(bounds) { this.bounds = bounds; }
  setVisible(visible) { this.visible = visible; }
}

function fakeSession(capture) {
  return {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    setDevicePermissionHandler() {},
    setDisplayMediaRequestHandler() {},
    on(event, handler) { if (event === 'will-download') capture(handler); },
    webRequest: { onBeforeRequest() {}, onHeadersReceived() {} },
  };
}

function loadHost() {
  const prevElectron = require.cache[electronId];
  const prevTauri = require.cache[tauriHostId];
  delete require.cache[browserHostId];

  const mainWindow = {
    isDestroyed: () => false,
    webContents: { id: 1, on() { return this; }, focus() {}, isDestroyed: () => false },
    contentView: { addChildView() {}, removeChildView() {} },
  };
  let host = null;

  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: {
      WebContentsView: FakeWebContentsView,
      session: { fromPartition: () => fakeSession(() => {}) },
      dialog: {
        showOpenDialog() { return Promise.resolve({ canceled: true }); },
        showSaveDialog() { return Promise.resolve({ canceled: true }); },
        showMessageBox() { return Promise.resolve({ response: 0 }); },
      },
    },
  };
  require.cache[tauriHostId] = {
    id: tauriHostId,
    filename: tauriHostId,
    loaded: true,
    exports: {
      emitEvent(event, payload) {
        if (event === 'browser://automation-open') {
          host.browserDispatch(null, 'browser_create', {
            id: payload.id, url: 'about:blank', x: 0, y: 0, width: 800, height: 600,
          });
        }
      },
      getMainWindow: () => mainWindow,
    },
  };

  host = require('./browserHost.cjs');
  const scratch = path.resolve(__dirname, '../.agent/temp');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'abu-shot-'));
  host.__testing.setDownloadRoot(root);

  return {
    host,
    root,
    restore() {
      host.__testing.setDownloadRoot(null);
      fs.rmSync(root, { recursive: true, force: true });
      if (prevElectron) require.cache[electronId] = prevElectron;
      else delete require.cache[electronId];
      if (prevTauri) require.cache[tauriHostId] = prevTauri;
      else delete require.cache[tauriHostId];
      delete require.cache[browserHostId];
    },
  };
}

async function openTab(host, ownerId) {
  const tabs = await host.performBrowserAutomation('get_tabs', { ownerId });
  const tabId = tabs.windows[0].tabs[0].tabId;
  return { tabId, contents: contentsRegistry.get(tabId) };
}

test('preparation returns the task destination without capturing or creating a file', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    const result = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, prepareSave: true,
    });

    const dir = path.join(root, OWNER_A, 'main', 'screenshots');
    assert.ok(result.path.startsWith(dir + path.sep), `path ${result.path} is not inside ${dir}`);
    assert.match(path.basename(result.path), new RegExp(`^screenshot-${tabId}-\\d{8}-\\d{6}\\.png$`));
    assert.equal(result.appDataRoot, path.dirname(root));
    assert.equal(result.taskDirectory, dir);
    assert.equal(path.join(result.appDataRoot, result.taskRelativeDirectory), dir);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(contents.debugger.sent('Page.captureScreenshot').length, 0);
  } finally { restore(); }
});

test('full-page capture returns PNG bytes for the authorized writer', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    const result = await host.performBrowserAutomation('screenshot_full_page', {
      ownerId: OWNER_A, tabId,
    });
    assert.equal(result, `data:image/png;base64,${PNG_B64}`);
    assert.equal(fs.existsSync(path.join(root, OWNER_A)), false);
    assert.ok(contents.debugger.sent('Page.getLayoutMetrics').length === 1, 'full-page capture reads layout metrics');
  } finally { restore(); }
});

test('an explicit savePath is used as-is, and a missing .png is appended', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const result = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, prepareSave: true, savePath: path.join(root, 'capture'),
    });
    assert.equal(result.path, path.join(root, 'capture.png'));
    assert.equal(fs.existsSync(result.path), false);
  } finally { restore(); }
});

test('an existing file is never overwritten — the name gets a -2 suffix', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const requested = path.join(root, 'capture.png');
    fs.writeFileSync(requested, 'the file the user was shown');

    const result = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, prepareSave: true, savePath: requested,
    });

    assert.equal(result.path, path.join(root, 'capture-2.png'));
    assert.equal(fs.readFileSync(requested, 'utf8'), 'the file the user was shown');
  } finally { restore(); }
});

test('a savePath that is a directory (trailing separator or existing) takes the derived name', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const dir = path.join(root, 'out');
    fs.mkdirSync(dir);

    const trailing = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, prepareSave: true, savePath: dir + path.sep,
    });
    assert.ok(trailing.path.startsWith(dir + path.sep));
    assert.match(path.basename(trailing.path), /^screenshot-\d+-\d{8}-\d{6}\.png$/);

    const existing = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, prepareSave: true, savePath: dir,
    });
    assert.ok(existing.path.startsWith(dir + path.sep));
  } finally { restore(); }
});

test('a relative savePath resolves against the task screenshot folder', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const result = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, prepareSave: true, savePath: path.join('shots', 'one.png'),
    });
    assert.equal(result.path, path.join(root, OWNER_A, 'main', 'screenshots', 'shots', 'one.png'));
    assert.equal(fs.existsSync(result.path), false);
  } finally { restore(); }
});

test('without saveMode the answer is exactly the old data URL', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const result = await host.performBrowserAutomation('screenshot', { ownerId: OWNER_A, tabId });
    assert.equal(result, `data:image/png;base64,${PNG_B64}`);
    assert.equal(fs.existsSync(path.join(root, OWNER_A, 'main', 'screenshots')), false, 'nothing was written');
  } finally { restore(); }
});

test('a direct saveMode request cannot write a file', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const target = path.join(root, 'capture.png');
    await assert.rejects(
      host.performBrowserAutomation('screenshot', {
        ownerId: OWNER_A, tabId, saveMode: true, savePath: target,
      }),
      /host file authorization/,
    );
    assert.equal(fs.existsSync(target), false);
  } finally { restore(); }
});

test('exhausting all screenshot filenames leaves the original file intact', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const target = path.join(root, 'capture.png');
    fs.writeFileSync(target, 'original');
    for (let n = 2; n < 1000; n += 1) fs.writeFileSync(path.join(root, `capture-${n}.png`), 'occupied');
    await assert.rejects(host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, prepareSave: true, savePath: target,
    }), /No available screenshot filename/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  } finally { restore(); }
});
