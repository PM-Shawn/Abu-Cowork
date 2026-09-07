'use strict';

/**
 * browserHost — downloads that belong to a task (T6), uploads that never open a
 * file picker (T5).
 *
 * ## What was wrong before T6
 *
 * `will-download` was watched only to keep a list of names. The FILE went
 * wherever Chromium's default download path pointed, under whatever name the
 * server's `Content-Disposition` chose, with no record of which run asked for
 * it — so a run could not tell the user where its export was, one task's
 * downloads sat in the same folder as another's, and `get_downloads` answered
 * every caller with the same browser-wide list.
 *
 * Three separate claims are pinned below, and they fail independently:
 *
 *  1. **Where it lands.** Under Abu's own root, one folder per owner, under a
 *     name this host derives. `setSavePath` being called synchronously inside
 *     the event is also what suppresses the "Save as" window — an OS-modal save
 *     dialog in an automation run is not a prompt, it is a deadlock.
 *  2. **Whose it is.** A download belongs to the run that armed a waiter before
 *     the click. Nobody armed ⇒ nobody owns it, and `get_downloads` is filtered
 *     where it is READ, not where records are made.
 *  3. **No OS picker, ever.** The chooser is intercepted for as long as
 *     automation is touching the tab and answered with an empty selection —
 *     which is exactly "the user pressed Cancel".
 *
 * Same technique as `browserHost.dialogs.test.cjs`: run the main-process module
 * under plain Node with `electron` and `tauriHost` pre-filled by fakes.
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
const OWNER_B = 'conversation-b';

let nextContentsId = 900;
const contentsRegistry = new Map();

class FakeDebugger {
  constructor() {
    this.attached = false;
    this.commands = [];
    this.listeners = new Map();
    /** CDP methods this build should pretend not to support. */
    this.unsupported = new Set();
  }

  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  detach() { this.attached = false; }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return this;
  }

  emit(event, ...args) {
    for (const handler of this.listeners.get(event) || []) handler(...args);
  }

  fireCdp(method, params) { this.emit('message', {}, method, params); }

  async sendCommand(method, params) {
    if (this.unsupported.has(method)) throw new Error(`'${method}' wasn't found`);
    this.commands.push({ method, params });
    if (method === 'Page.captureScreenshot') return { data: 'AAAA' };
    if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 10, height: 10 } };
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
    /** Every `handleAction` payload the isolated world was asked to run. */
    this.domCalls = [];
    /** Called while a `click` is in flight — how a test makes one produce a file. */
    this.onClick = null;
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return this;
  }

  once(event, handler) { return this.on(event, handler); }

  fire(event, ...args) {
    for (const handler of this.listeners.get(event) || []) handler(...args);
  }

  setWindowOpenHandler() {}
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  focus() {}
  sendInputEvent() {}
  reload() {}

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.fire('destroyed');
  }

  async loadURL(url) { this.url = url; return undefined; }

  async executeJavaScriptInIsolatedWorld(_worldId, scripts) {
    const code = scripts && scripts[0] ? scripts[0].code : '';
    if (/typeof globalThis/.test(code)) return true;
    if (!/handleAction/.test(code)) return true;
    // `installAutomationRuntime` probes with code that MENTIONS handleAction
    // without calling it; only a real dispatch is recorded.
    const parsed = /handleAction\(\s*("(?:[^"\\]|\\.)*"),\s*([\s\S]*?)\s*\)\s*$/.exec(code.trim());
    if (!parsed) return { success: true, message: 'ok' };
    const action = JSON.parse(parsed[1]);
    const payload = JSON.parse(parsed[2]);
    this.domCalls.push({ action, payload });
    if (action === 'click' && this.onClick) this.onClick();
    return { success: true, message: 'ok' };
  }
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

/** A download item, in the shape `will-download` hands one over. */
class FakeDownloadItem {
  constructor({ filename = 'report.xlsx', url = 'https://x.example/report.xlsx', totalBytes = 1024 } = {}) {
    this.filename = filename;
    this.url = url;
    this.totalBytes = totalBytes;
    this.state = 'progressing';
    this.savePath = null;
    this.cancelled = false;
    this.listeners = new Map();
  }

  getFilename() { return this.filename; }
  getURL() { return this.url; }
  getState() { return this.state; }
  getTotalBytes() { return this.totalBytes; }
  getReceivedBytes() { return this.totalBytes; }
  getMimeType() { return 'application/vnd.ms-excel'; }
  setSavePath(p) { this.savePath = p; }
  cancel() { this.cancelled = true; }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return this;
  }

  once(event, handler) { return this.on(event, handler); }

  fire(event, ...args) {
    for (const handler of this.listeners.get(event) || []) handler(...args);
  }

  /** Reach a terminal state the way Electron does. */
  finish(state = 'completed') {
    this.state = state;
    this.fire('done', {}, state);
  }
}

/**
 * The one thing this whole feature promises never to do. A real
 * `showOpenDialog` / `showSaveDialog` here would be the OS-modal deadlock the
 * PRD calls 「弹出即死锁」, so the fake `electron` module carries both and every
 * test asserts the counter stayed at zero.
 */
const osDialogCalls = { showOpenDialog: 0, showSaveDialog: 0, showMessageBox: 0 };

function fakeSession(capture) {
  return {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    setDevicePermissionHandler() {},
    setDisplayMediaRequestHandler() {},
    on(event, handler) { if (event === 'will-download') capture(handler); },
    webRequest: { onHeadersReceived() {} },
  };
}

function loadHost() {
  const prevElectron = require.cache[electronId];
  const prevTauri = require.cache[tauriHostId];
  delete require.cache[browserHostId];

  osDialogCalls.showOpenDialog = 0;
  osDialogCalls.showSaveDialog = 0;
  osDialogCalls.showMessageBox = 0;

  const mainWindow = {
    isDestroyed: () => false,
    webContents: { id: 1, on() { return this; }, focus() {}, isDestroyed: () => false },
    contentView: { addChildView() {}, removeChildView() {} },
  };
  let host = null;
  let willDownload = null;

  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: {
      WebContentsView: FakeWebContentsView,
      session: { fromPartition: () => fakeSession((handler) => { willDownload = handler; }) },
      dialog: {
        showOpenDialog() { osDialogCalls.showOpenDialog += 1; return Promise.resolve({ canceled: true }); },
        showSaveDialog() { osDialogCalls.showSaveDialog += 1; return Promise.resolve({ canceled: true }); },
        showMessageBox() { osDialogCalls.showMessageBox += 1; return Promise.resolve({ response: 0 }); },
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-dl-'));
  host.__testing.setDownloadRoot(root);
  host.__testing.resetDownloads();

  return {
    host,
    root,
    /** Play a `will-download` for the tab that owns `contents`. */
    deliver(item, contents) {
      assert.ok(willDownload, 'the browser session has not been created yet');
      willDownload({}, item, contents);
      return item;
    },
    restore() {
      host.__testing.setDownloadRoot(null);
      host.__testing.resetDownloads();
      fs.rmSync(root, { recursive: true, force: true });
      if (prevElectron) require.cache[electronId] = prevElectron;
      else delete require.cache[electronId];
      if (prevTauri) require.cache[tauriHostId] = prevTauri;
      else delete require.cache[tauriHostId];
      delete require.cache[browserHostId];
    },
  };
}

/** Provision one automation tab for an owner and hand back its ids. */
async function openTab(host, ownerId) {
  const tabs = await host.performBrowserAutomation('get_tabs', { ownerId });
  const tabId = tabs.windows[0].tabs[0].tabId;
  return { tabId, contents: contentsRegistry.get(tabId) };
}

function noOsDialogs() {
  assert.deepEqual(
    osDialogCalls,
    { showOpenDialog: 0, showSaveDialog: 0, showMessageBox: 0 },
    'an automation run must never raise an OS-modal dialog',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Where the file lands
// ═══════════════════════════════════════════════════════════════════════════

test('redirects a download into Abu\'s own per-task folder, synchronously, with no Save-as anywhere', async () => {
  const { host, root, deliver, restore } = loadHost();
  try {
    const { contents } = await openTab(host, OWNER_A);
    const item = deliver(new FakeDownloadItem(), contents);

    // Synchronously — the save path has to be set before the event handler
    // returns or Chromium falls back to asking the user.
    assert.ok(item.savePath, 'setSavePath was not called during the event');
    assert.ok(item.savePath.startsWith(root), `${item.savePath} is outside ${root}`);
    assert.equal(path.basename(item.savePath), 'report.xlsx');
    assert.ok(item.savePath.includes(OWNER_A), 'the file is not filed under its owner');
    assert.equal(item.cancelled, false);
    noOsDialogs();
  } finally { restore(); }
});

test('derives the file name instead of accepting the one the server sent', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const { contents } = await openTab(host, OWNER_A);

    const cases = [
      ['../../../../etc/passwd', 'passwd'],
      ['C:\\Windows\\System32\\evil.dll', 'evil.dll'],
      ['a:b*c?d"e<f>g|h.txt', 'a_b_c_d_e_f_g_h.txt'],
      ['...bashrc', 'bashrc'],
      // Non-ASCII is deliberately KEPT — 排班表.xlsx is the normal case here.
      ['排班表.xlsx', '排班表.xlsx'],
    ];
    for (const [sent, expected] of cases) {
      const item = deliver(new FakeDownloadItem({ filename: sent }), contents);
      assert.equal(path.basename(item.savePath), expected, `for ${sent}`);
    }
    noOsDialogs();
  } finally { restore(); }
});

test('gives the second copy of a name its own file rather than overwriting the first', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const { contents } = await openTab(host, OWNER_A);

    const first = deliver(new FakeDownloadItem(), contents);
    fs.writeFileSync(first.savePath, 'one');
    const second = deliver(new FakeDownloadItem(), contents);

    assert.equal(path.basename(first.savePath), 'report.xlsx');
    assert.equal(path.basename(second.savePath), 'report (2).xlsx');
  } finally { restore(); }
});

test('cancels a download it has nowhere to put, rather than letting Chromium choose', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const { contents } = await openTab(host, OWNER_A);
    // A root that cannot be created: a FILE where the directory should go.
    const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'abu-blocked-')), 'root');
    fs.writeFileSync(blocked, 'not a directory');
    host.__testing.setDownloadRoot(blocked);

    const item = deliver(new FakeDownloadItem(), contents);

    assert.equal(item.savePath, null, 'no save path was handed to Chromium');
    assert.equal(item.cancelled, true);
    noOsDialogs();
  } finally { restore(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// Whose it is
// ═══════════════════════════════════════════════════════════════════════════

test('one task never sees another task\'s downloads', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const a = await openTab(host, OWNER_A);
    const b = await openTab(host, OWNER_B);

    deliver(new FakeDownloadItem({ filename: 'a.csv' }), a.contents).finish();
    deliver(new FakeDownloadItem({ filename: 'b.csv' }), b.contents).finish();

    const forA = await host.performBrowserAutomation('get_downloads', { ownerId: OWNER_A });
    const forB = await host.performBrowserAutomation('get_downloads', { ownerId: OWNER_B });

    assert.deepEqual(forA.map((d) => d.filename), ['a.csv']);
    assert.deepEqual(forB.map((d) => d.filename), ['b.csv']);
    // And the internal owner key is never part of what the model is told.
    assert.ok(!JSON.stringify(forA).includes(OWNER_B));
  } finally { restore(); }
});

test('a task that downloaded nothing gets an empty list, not the neighbour\'s exports', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const a = await openTab(host, OWNER_A);
    deliver(new FakeDownloadItem(), a.contents).finish();

    const forB = await host.performBrowserAutomation('get_downloads', { ownerId: OWNER_B });
    assert.deepEqual(forB, []);
  } finally { restore(); }
});

test('refuses to wait on a download id that belongs to somebody else, the same way it refuses an unknown one', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const a = await openTab(host, OWNER_A);
    const b = await openTab(host, OWNER_B);
    deliver(new FakeDownloadItem(), a.contents).finish();
    const [mine] = await host.performBrowserAutomation('get_downloads', { ownerId: OWNER_A });

    const messages = [];
    for (const downloadId of [mine.downloadId, 'dl_does_not_exist']) {
      await assert.rejects(
        host.performBrowserAutomation('download', {
          ownerId: OWNER_B, tabId: b.tabId, action: 'wait', downloadId,
        }),
        (error) => { messages.push(error.message); return true; },
      );
    }
    // Ownership before existence: two different questions, one answer shape,
    // or a task could probe for another's downloads.
    assert.match(messages[0], /belongs to this task/);
    assert.match(messages[1], /belongs to this task/);
  } finally { restore(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// The `download` tool
// ═══════════════════════════════════════════════════════════════════════════

test('presses the export control and comes back with the file it produced', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    contents.onClick = () => {
      deliver(new FakeDownloadItem({ filename: '排班表.xlsx' }), contents).finish();
    };

    const result = await host.performBrowserAutomation('download', {
      ownerId: OWNER_A, tabId, action: 'click', locator: { css: 'a#export' }, timeoutMs: 5000,
    });

    assert.equal(result.started, true);
    assert.equal(result.complete, true);
    assert.equal(result.download.filename, '排班表.xlsx');
    assert.ok(result.download.path.includes(OWNER_A));
    assert.match(result.message, /Saved to /);
    // The click really went through the ordinary DOM path.
    assert.equal(contents.domCalls[0].action, 'click');
    noOsDialogs();
  } finally { restore(); }
});

test('says the click produced no download rather than adopting some other file', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const a = await openTab(host, OWNER_A);
    const b = await openTab(host, OWNER_B);
    // Task B downloads something in the same instant. A armed a waiter, B did
    // not — but the file came from B's tab, so it is B's and A must not take it.
    a.contents.onClick = () => {
      deliver(new FakeDownloadItem({ filename: 'not-yours.csv' }), b.contents);
    };

    const result = await host.performBrowserAutomation('download', {
      ownerId: OWNER_A, tabId: a.tabId, action: 'click', locator: { css: 'a#export' }, timeoutMs: 5,
    });

    assert.equal(result.started, false);
    assert.match(result.message, /no other file was adopted/);
  } finally { restore(); }
});

test('reports an interrupted download as interrupted, and does not call it saved', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    contents.onClick = () => {
      deliver(new FakeDownloadItem(), contents).finish('interrupted');
    };

    const result = await host.performBrowserAutomation('download', {
      ownerId: OWNER_A, tabId, action: 'click', locator: { css: 'a#export' }, timeoutMs: 5000,
    });

    assert.equal(result.started, true);
    assert.equal(result.complete, false);
    assert.equal(result.download.state, 'interrupted');
    assert.match(result.message, /did not finish/);
  } finally { restore(); }
});

test('hands a slow download back as an id to poll instead of blocking past its budget', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    let started = null;
    contents.onClick = () => { started = deliver(new FakeDownloadItem(), contents); };

    const first = await host.performBrowserAutomation('download', {
      ownerId: OWNER_A, tabId, action: 'click', locator: { css: 'a#export' }, timeoutMs: 5,
    });

    assert.equal(first.started, true);
    assert.equal(first.complete, false);
    assert.match(first.message, /Still downloading/);

    started.finish();
    const second = await host.performBrowserAutomation('download', {
      ownerId: OWNER_A, tabId, action: 'wait', downloadId: first.download.downloadId, timeoutMs: 5000,
    });

    assert.equal(second.complete, true);
    assert.equal(second.download.downloadId, first.download.downloadId);
  } finally { restore(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// Uploads: the bytes, and the picker that never opens
// ═══════════════════════════════════════════════════════════════════════════

test('opens the approved file itself and hands the CONTENT to the DOM runtime — never a path', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    const file = path.join(root, '排班表.xlsx');
    fs.writeFileSync(file, 'hello');

    await host.performBrowserAutomation('upload_file', {
      ownerId: OWNER_A,
      tabId,
      locator: { css: 'input[type=file]' },
      files: [{ path: file, name: '排班表.xlsx', size: 5 }],
    });

    const call = contents.domCalls.find((c) => c.action === 'upload_file');
    assert.ok(call, 'the upload never reached the DOM runtime');
    assert.deepEqual(call.payload.files, [
      { name: '排班表.xlsx', size: 5, base64: Buffer.from('hello').toString('base64') },
    ]);
    // The page-side runtime is told a name and bytes. Where the file lives on
    // the user's disk is not the page's business.
    assert.ok(!JSON.stringify(call.payload).includes(root));
    noOsDialogs();
  } finally { restore(); }
});

test('refuses a file that changed on disk since the confirmation named its size', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    const file = path.join(root, 'swapped.txt');
    fs.writeFileSync(file, 'much longer than it was');

    await assert.rejects(
      host.performBrowserAutomation('upload_file', {
        ownerId: OWNER_A,
        tabId,
        locator: { css: 'input[type=file]' },
        files: [{ path: file, name: 'swapped.txt', size: 5 }],
      }),
      /changed on disk/,
    );
    assert.equal(contents.domCalls.filter((c) => c.action === 'upload_file').length, 0);
  } finally { restore(); }
});

test('refuses an upload whose approved list is missing or unreadable', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const file = path.join(root, 'ok.txt');
    fs.writeFileSync(file, 'x');

    for (const files of [undefined, [], [{ path: file }], [{ name: 'ok.txt', size: 1 }]]) {
      await assert.rejects(
        host.performBrowserAutomation('upload_file', {
          ownerId: OWNER_A, tabId, locator: { css: 'input' }, ...(files ? { files } : {}),
        }),
        /Refused/,
      );
    }
    noOsDialogs();
  } finally { restore(); }
});

test('refuses to upload a directory even if the approved list names one', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, OWNER_A);
    const dir = path.join(root, 'folder');
    fs.mkdirSync(dir);

    await assert.rejects(
      host.performBrowserAutomation('upload_file', {
        ownerId: OWNER_A, tabId, locator: { css: 'input' },
        files: [{ path: dir, name: 'folder', size: 0 }],
      }),
      /not an ordinary file/,
    );
  } finally { restore(); }
});

/**
 * The guard for the OTHER way a picker opens: the model clicks a 「选择文件」
 * button, or the page calls `input.click()` while automation is driving.
 * Without interception Chromium raises a native modal that nothing in this
 * process can dismiss and no automated run can answer.
 */
test('arms file-chooser interception while automation drives a tab, and answers a chooser with Cancel', async () => {
  const { host, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    await host.performBrowserAutomation('click', {
      ownerId: OWNER_A, tabId, locator: { css: '#browse' },
    });

    const armed = contents.debugger.sent('Page.setInterceptFileChooserDialog');
    assert.equal(armed.length, 1);
    assert.deepEqual(armed[0].params, { enabled: true });

    contents.debugger.fireCdp('Page.fileChooserOpened', { backendNodeId: 42 });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    const cancelled = contents.debugger.sent('DOM.setFileInputFiles');
    assert.equal(cancelled.length, 1, 'the chooser was left hanging instead of cancelled');
    // An empty selection IS Cancel, in CDP's vocabulary.
    assert.deepEqual(cancelled[0].params, { files: [], backendNodeId: 42 });
    noOsDialogs();
  } finally { restore(); }
});

test('a read-only action never arms the chooser interception on the user\'s tab', async () => {
  const { host, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    await host.performBrowserAutomation('extract_text', { ownerId: OWNER_A, tabId });

    assert.equal(contents.debugger.sent('Page.setInterceptFileChooserDialog').length, 0);
  } finally { restore(); }
});

/**
 * Interception is best-effort and SEPARATE from the dialog interception it
 * shares a lease with: an Electron build without the CDP method must not cost
 * the tab its javascript-dialog handling, which is the older and more
 * load-bearing of the two.
 */
test('keeps dialog interception when the chooser CDP method is unavailable', async () => {
  const { host, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    contents.debugger.unsupported.add('Page.setInterceptFileChooserDialog');

    await host.performBrowserAutomation('click', { ownerId: OWNER_A, tabId, locator: { css: '#x' } });

    assert.equal(contents.debugger.sent('Page.enable').length, 1);
    assert.equal(contents.debugger.sent('Page.setInterceptFileChooserDialog').length, 0);
  } finally { restore(); }
});

test('ignores a chooser event that names no node instead of throwing inside the CDP listener', async () => {
  const { host, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    await host.performBrowserAutomation('click', { ownerId: OWNER_A, tabId, locator: { css: '#x' } });

    contents.debugger.fireCdp('Page.fileChooserOpened', {});
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    assert.equal(contents.debugger.sent('DOM.setFileInputFiles').length, 0);
  } finally { restore(); }
});
