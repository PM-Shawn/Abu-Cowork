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

const { toFileInfo } = require('./fsHost.cjs');

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

/**
 * The approved-file entry the gate would have frozen for `file`.
 *
 * Identity, not just length (review F1): `uploadAutomation` opens the file
 * with `O_NOFOLLOW` and compares an `fstat` of that descriptor against this,
 * so a fixture that carries only a size is refused — which several cases below
 * rely on.
 */
function approvedEntry(file, name, sizeOverride) {
  const stat = fs.lstatSync(file);
  return {
    path: file,
    name: name || path.basename(file),
    size: sizeOverride === undefined ? stat.size : sizeOverride,
    mtimeMs: Math.floor(stat.mtimeMs),
    ino: stat.ino,
    dev: stat.dev,
  };
}

/**
 * The approved entry the RENDERER GATE would freeze for this file — built
 * through the two hops that actually separate the gate from this process,
 * instead of `approvedEntry`'s shortcut:
 *
 *   1. `fsHost.toFileInfo` puts the timestamp on the wire as an ISO string;
 *   2. plugin-fs's `parseFileInfo` turns it back into a `Date`
 *      (`@tauri-apps/plugin-fs/dist-js/index.js`, `mtime: new Date(r.mtime)`);
 *   3. `registry.ts` freezes `Math.floor(info.mtime.getTime())`.
 *
 * `approvedEntry` reads `Math.floor(stat.mtimeMs)` straight off the disk — the
 * same derivation the sender uses — so it can never catch the two tiers
 * disagreeing. That disagreement is what refused roughly half of all uploads
 * of an UNCHANGED file with 「changed on disk」 (acceptance F1).
 */
function gateApprovedEntry(file, name) {
  const wire = toFileInfo(fs.lstatSync(file));
  const asPluginFsParsesIt = wire.mtime === null ? null : new Date(wire.mtime);
  return {
    path: file,
    name: name || path.basename(file),
    size: wire.size,
    mtimeMs: asPluginFsParsesIt === null ? 0 : Math.floor(asPluginFsParsesIt.getTime()),
    ino: wire.ino,
    dev: wire.dev,
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

/**
 * Review F3. `will-download` is a SESSION event and the pane tabs the user
 * browses in share that session with the automation views, so redirecting on
 * the legacy owner took the user's own downloads too: a PDF they clicked in
 * Abu's browser panel vanished into app-data with no dialog and no notice.
 */
test('leaves a download from a tab this host does not own where Chromium would put it', async () => {
  const { host, root, deliver, restore } = loadHost();
  try {
    await openTab(host, OWNER_A);
    // A contents no automation view owns — the user's own pane tab.
    const usersOwnTab = new FakeWebContents();
    const item = deliver(new FakeDownloadItem({ filename: 'my-tax-return.pdf' }), usersOwnTab);

    assert.equal(item.savePath, null, 'the user\'s own download was redirected');
    assert.equal(item.cancelled, false);
    assert.equal(fs.existsSync(path.join(root, 'legacy')), false, 'a folder was made for it anyway');
    // It is still RECORDED, in its own bucket, so no task can see it.
    const forA = await host.performBrowserAutomation('get_downloads', { ownerId: OWNER_A });
    assert.deepEqual(forA, []);
    noOsDialogs();
  } finally { restore(); }
});

test('still follows a legacy download to its terminal state without inventing a path for it', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    await openTab(host, OWNER_A);
    const usersOwnTab = new FakeWebContents();
    const item = deliver(new FakeDownloadItem({ filename: 'notes.pdf' }), usersOwnTab);
    item.finish('interrupted');

    const forA = await host.performBrowserAutomation('get_downloads', { ownerId: OWNER_A });
    assert.deepEqual(forA, []);
    assert.equal(item.savePath, null);
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

/**
 * Review F5. The click wait and the completion wait each took the FULL
 * `timeoutMs`, so the worst case was double what the bridge budgeted for
 * (`waitMs + 15 s`): a file that started at 29 s and finished at 55 s was
 * reported to the model as an unresponsive browser, with the `downloadId`
 * needed to poll for it lost inside the error.
 */
test('spends one budget on the whole call, not one on each half', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    let started = null;
    // The shape that separates the two designs: the click takes MOST of the
    // budget to produce anything, and then the file never finishes. With one
    // deadline the whole call costs ~300 ms; with a budget per phase it costs
    // 200 + 300, which is what walked past the bridge's own timeout.
    contents.onClick = () => {
      setTimeout(() => { started = deliver(new FakeDownloadItem(), contents); }, 200);
    };

    const began = Date.now();
    const result = await host.performBrowserAutomation('download', {
      ownerId: OWNER_A, tabId, action: 'click', locator: { css: 'a#export' }, timeoutMs: 300,
    });
    const spent = Date.now() - began;

    assert.equal(result.started, true);
    assert.equal(result.complete, false);
    assert.ok(spent < 420, `the call spent ${spent}ms of a 300ms budget`);
    if (started) started.finish();
  } finally { restore(); }
});

/**
 * Review F12. Abandoning the wait is not stopping the download: the file kept
 * arriving in the task's folder after the user pressed Stop.
 */
test('cancels the file it is downloading when the run is stopped', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    const controller = new AbortController();
    let started = null;
    contents.onClick = () => {
      started = deliver(new FakeDownloadItem(), contents);
      // The user presses Stop while the file is still coming down.
      setTimeout(() => controller.abort(), 0);
    };

    const result = await host.performBrowserAutomation('download', {
      ownerId: OWNER_A, tabId, action: 'click', locator: { css: 'a#export' }, timeoutMs: 60_000,
    }, { signal: controller.signal });

    assert.equal(started.cancelled, true, 'the download was left running after Stop');
    assert.equal(result.complete, false);
  } finally { restore(); }
});

test('does NOT cancel a download that merely outlasted its budget — that one is polled', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    let started = null;
    contents.onClick = () => { started = deliver(new FakeDownloadItem(), contents); };

    const result = await host.performBrowserAutomation('download', {
      ownerId: OWNER_A, tabId, action: 'click', locator: { css: 'a#export' }, timeoutMs: 5,
    });

    assert.equal(started.cancelled, false, 'a slow download was killed instead of polled');
    assert.match(result.message, /Still downloading/);
    started.finish();
  } finally { restore(); }
});

/**
 * Review F9. The cap used to be global, so a busy task evicted its
 * neighbour's records and the neighbour's next `wait` was told its own
 * download did not belong to it.
 */
test('one task filling the list does not evict its neighbour\'s downloads', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const a = await openTab(host, OWNER_A);
    const b = await openTab(host, OWNER_B);

    deliver(new FakeDownloadItem({ filename: 'b-first.csv' }), b.contents).finish();
    const [mine] = await host.performBrowserAutomation('get_downloads', { ownerId: OWNER_B });
    for (let i = 0; i < 25; i += 1) {
      deliver(new FakeDownloadItem({ filename: `a-${i}.csv` }), a.contents).finish();
    }

    const forB = await host.performBrowserAutomation('get_downloads', { ownerId: OWNER_B });
    assert.deepEqual(forB.map((d) => d.filename), ['b-first.csv']);
    // And it is still waitable by id, which is what the eviction broke.
    const waited = await host.performBrowserAutomation('download', {
      ownerId: OWNER_B, tabId: b.tabId, action: 'wait', downloadId: mine.downloadId, timeoutMs: 5,
    });
    assert.equal(waited.download.downloadId, mine.downloadId);
    // A owns 20 — its own cap, applied to its own bucket.
    const forA = await host.performBrowserAutomation('get_downloads', { ownerId: OWNER_A });
    assert.equal(forA.length, 20);
  } finally { restore(); }
});

/**
 * Review F8. The old rule capped at 120 CHARACTERS and left the Windows
 * device names and trailing dots alone: 120 CJK characters is 360 bytes, past
 * every filesystem's 255-byte limit, and `setSavePath` accepts it silently —
 * the download just ends `interrupted` with nothing to act on.
 */
test('derives a name the filesystem will actually accept', async () => {
  const { host, deliver, restore } = loadHost();
  try {
    const { contents } = await openTab(host, OWNER_A);

    const cases = [
      // A Windows device name, whatever extension follows it.
      ['CON.txt', '_CON.txt'],
      ['nul', '_nul'],
      ['com9.csv', '_com9.csv'],
      // Windows drops a trailing dot or space, silently merging two names.
      ['report.txt.', 'report.txt'],
      ['report.txt   ', 'report.txt'],
      // Not reserved — the rule is a whole-name match, not a prefix.
      ['console.log', 'console.log'],
    ];
    for (const [sent, expected] of cases) {
      const item = deliver(new FakeDownloadItem({ filename: sent }), contents);
      assert.equal(path.basename(item.savePath), expected, `for ${sent}`);
    }

    const long = deliver(new FakeDownloadItem({ filename: `${'排'.repeat(200)}.xlsx` }), contents);
    const name = path.basename(long.savePath);
    assert.ok(Buffer.byteLength(name, 'utf8') <= 200, `${Buffer.byteLength(name, 'utf8')} bytes`);
    // Cut on a character boundary, not mid-sequence.
    assert.equal(name.includes('\ufffd'), false);
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
      files: [approvedEntry(file, '排班表.xlsx')],
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

test('sends a file the gate pinned through the real fs wire, sub-millisecond mtime and all', async (t) => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    const file = path.join(root, '月度报表.csv');
    fs.writeFileSync(file, 'a,b\n1,2\n');
    // A modification time whose sub-millisecond remainder is .73 — the half of
    // all files that `Math.round` (Node's `Stats.mtime`) and `Math.floor` (the
    // sender) disagree about.
    fs.utimesSync(file, 1_700_000_000.73073, 1_700_000_000.73073);
    if (fs.lstatSync(file).mtimeMs % 1 === 0) {
      t.skip('this filesystem stores whole milliseconds, so there is nothing to disagree about');
      return;
    }

    await host.performBrowserAutomation('upload_file', {
      ownerId: OWNER_A,
      tabId,
      locator: { css: 'input[type=file]' },
      files: [gateApprovedEntry(file, '月度报表.csv')],
    });

    const call = contents.domCalls.find((c) => c.action === 'upload_file');
    assert.ok(call, 'an unchanged file was refused as 「changed on disk」');
    assert.equal(call.payload.files[0].name, '月度报表.csv');
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
        files: [{ ...approvedEntry(file, 'swapped.txt'), size: 5 }],
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

    for (const files of [
      undefined,
      [],
      [{ path: file }],
      [{ name: 'ok.txt', size: 1 }],
      // Review F1 — a stamp with no identity in it is refused rather than
      // compared by length, which is the comparison a same-size swap defeats.
      [{ path: file, name: 'ok.txt', size: 1 }],
    ]) {
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
        files: [approvedEntry(dir, 'folder')],
      }),
      /not an ordinary file/,
    );
  } finally { restore(); }
});

/**
 * ## The identity pin (2026-09-07 review F1)
 *
 * The three cases below are the ones `size` alone could not tell apart. The
 * first is the probe that produced the finding: an 8-byte file is approved,
 * and while the user reads the dialog the path becomes a symbolic link to an
 * 8-byte secret. `statSync` follows links, so the old sender read the secret
 * and the page received it — with `{"success":true}`.
 */
test('refuses a file replaced by a same-size symbolic link after the confirmation', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    const approvedPath = path.join(root, 'report.txt');
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(approvedPath, 'PUBLIC!!');
    fs.writeFileSync(secret, 'SECRET!!');
    const approved = approvedEntry(approvedPath, 'report.txt');
    fs.unlinkSync(approvedPath);
    fs.symlinkSync(secret, approvedPath);

    await assert.rejects(
      host.performBrowserAutomation('upload_file', {
        ownerId: OWNER_A, tabId, locator: { css: 'input[type=file]' }, files: [approved],
      }),
      /symbolic link now|changed on disk/,
    );
    assert.equal(contents.domCalls.filter((c) => c.action === 'upload_file').length, 0);
    noOsDialogs();
  } finally { restore(); }
});

test('refuses a same-size DIFFERENT file moved into the approved path', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    const approvedPath = path.join(root, 'report.txt');
    fs.writeFileSync(approvedPath, 'PUBLIC!!');
    const approved = approvedEntry(approvedPath, 'report.txt');
    const other = path.join(root, 'other.txt');
    fs.writeFileSync(other, 'SECRET!!');
    fs.renameSync(other, approvedPath);
    // Round-2 review N5. Both writes are the same length, so the ONLY thing
    // that should reject this is the inode — but two `writeFileSync` calls
    // usually land in different milliseconds, and the mtime check got there
    // first. The test then passed for a reason it was not testing: a mutation
    // that deletes the `ino`/`dev` comparison went red only when the clock
    // happened to disagree. Freeze the clock onto the approved value and the
    // identity pin is the one thing left standing.
    const frozen = new Date(approved.mtimeMs);
    fs.utimesSync(approvedPath, frozen, frozen);
    assert.equal(Math.floor(fs.lstatSync(approvedPath).mtimeMs), approved.mtimeMs);
    assert.equal(fs.lstatSync(approvedPath).size, approved.size);
    assert.notEqual(fs.lstatSync(approvedPath).ino, approved.ino);

    await assert.rejects(
      host.performBrowserAutomation('upload_file', {
        ownerId: OWNER_A, tabId, locator: { css: 'input[type=file]' }, files: [approved],
      }),
      /changed on disk/,
    );
    assert.equal(contents.domCalls.filter((c) => c.action === 'upload_file').length, 0);
  } finally { restore(); }
});

test('refuses a same-size rewrite in place, which keeps the inode', async () => {
  const { host, root, restore } = loadHost();
  try {
    const { tabId, contents } = await openTab(host, OWNER_A);
    const approvedPath = path.join(root, 'report.txt');
    fs.writeFileSync(approvedPath, 'PUBLIC!!');
    const approved = approvedEntry(approvedPath, 'report.txt');
    fs.writeFileSync(approvedPath, 'SECRET!!');
    const moved = new Date(approved.mtimeMs + 5000);
    fs.utimesSync(approvedPath, moved, moved);

    await assert.rejects(
      host.performBrowserAutomation('upload_file', {
        ownerId: OWNER_A, tabId, locator: { css: 'input[type=file]' }, files: [approved],
      }),
      /changed on disk/,
    );
    assert.equal(contents.domCalls.filter((c) => c.action === 'upload_file').length, 0);
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
