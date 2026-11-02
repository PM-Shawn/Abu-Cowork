'use strict';

/**
 * browserHost — screenshots that land as FILES (saveMode).
 *
 * ## Why this exists
 *
 * The screenshot actions were "capture for the model to look at": a base64
 * data URL came back and nothing ever touched the disk. For a model without
 * vision that picture is stripped on the way out anyway — the capture existed
 * only in memory, the user could not reach it, and a later vision-capable or
 * OCR step had nothing to read. `saveMode` (stamped by the bridge when the
 * host says the model cannot consume images, or asked for by the model's own
 * `saveToFile`/`savePath` arguments) writes the PNG into a folder Abu owns —
 * per task, like a download — and answers with `{path, width, height, bytes}`.
 *
 * Claims pinned here, failing independently:
 *
 *  1. **Where it lands.** No `savePath` ⇒ the task's own `screenshots/` folder
 *     under a name derived here. An explicit `savePath` is honored as given:
 *     a directory gets the derived name inside it, a file path is used as-is
 *     with a missing `.png` appended, a relative one resolves against the
 *     task folder.
 *  2. **Nothing is overwritten.** A name already on disk is suffixed `-2`,
 *     `-3`, … — the file at the requested path may be the one the user was
 *     shown.
 *  3. **The description is honest.** `width`/`height` come from the PNG header
 *     in hand, `bytes` from what was actually written; and without `saveMode`
 *     the answer is exactly the old data URL.
 *
 * Same technique as `browserHost.downloads.test.cjs`: run the main-process
 * module under plain Node with `electron` and `tauriHost` pre-filled by fakes.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const electronId = require.resolve('electron');
const tauriHostId = require.resolve('./tauriHost.cjs');
const browserHostId = require.resolve('./browserHost.cjs');

const OWNER_A = 'conversation-a';

let nextContentsId = 900;
const contentsRegistry = new Map();

/** A capture with a real IHDR, so the header parse has something true to read. */
function pngWithSize(width, height) {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head.writeUInt8(8, 24);
  head.writeUInt8(6, 25);
  return head;
}
const PNG_B64 = pngWithSize(1280, 800).toString('base64');

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-shot-'));
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

test('saveMode writes the capture into the task screenshot folder and describes it', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const result = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, saveMode: true,
    });

    assert.equal(result.saved, true);
    const dir = path.join(root, OWNER_A, 'main', 'screenshots');
    assert.ok(result.path.startsWith(dir + path.sep), `path ${result.path} is not inside ${dir}`);
    assert.match(path.basename(result.path), new RegExp(`^screenshot-${tabId}-\\d{8}-\\d{6}\\.png$`));
    assert.equal(result.width, 1280);
    assert.equal(result.height, 800);
    const written = fs.readFileSync(result.path);
    assert.equal(result.bytes, written.length);
    assert.ok(written.subarray(0, 8).equals(pngWithSize(0, 0).subarray(0, 8)), 'the PNG bytes were written');
  } finally { restore(); }
});

test('saveMode full-page capture saves too', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    const result = await host.performBrowserAutomation('screenshot_full_page', {
      ownerId: OWNER_A, tabId, saveMode: true,
    });
    assert.equal(result.saved, true);
    assert.ok(result.path.startsWith(path.join(root, OWNER_A, 'main', 'screenshots') + path.sep));
    assert.ok(contents.debugger.sent('Page.getLayoutMetrics').length === 1, 'full-page capture reads layout metrics');
  } finally { restore(); }
});

test('an explicit savePath is used as-is, and a missing .png is appended', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const result = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, saveMode: true, savePath: path.join(root, 'capture'),
    });
    assert.equal(result.path, path.join(root, 'capture.png'));
    assert.ok(fs.existsSync(result.path));
  } finally { restore(); }
});

test('an existing file is never overwritten — the name gets a -2 suffix', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const requested = path.join(root, 'capture.png');
    fs.writeFileSync(requested, 'the file the user was shown');

    const result = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, saveMode: true, savePath: requested,
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
      ownerId: OWNER_A, tabId, saveMode: true, savePath: dir + path.sep,
    });
    assert.ok(trailing.path.startsWith(dir + path.sep));
    assert.match(path.basename(trailing.path), /^screenshot-\d+-\d{8}-\d{6}\.png$/);

    const existing = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, saveMode: true, savePath: dir,
    });
    assert.ok(existing.path.startsWith(dir + path.sep));
  } finally { restore(); }
});

test('a relative savePath resolves against the task screenshot folder', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const result = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A, tabId, saveMode: true, savePath: path.join('shots', 'one.png'),
    });
    assert.equal(result.path, path.join(root, OWNER_A, 'main', 'screenshots', 'shots', 'one.png'));
    assert.ok(fs.existsSync(result.path));
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

test('a savePath under a file, not a directory, fails loudly', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const block = path.join(root, 'blocker');
    fs.writeFileSync(block, 'a file where a directory would have to go');
    await assert.rejects(
      host.performBrowserAutomation('screenshot', {
        ownerId: OWNER_A, tabId, saveMode: true, savePath: path.join(block, 'x.png'),
      }),
    );
  } finally { restore(); }
});
