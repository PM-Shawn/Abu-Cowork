'use strict';

/**
 * browserHost — per-conversation tab ownership.
 *
 * Before this suite, `browserHost.cjs` kept ONE global `activeAutomationTabId`
 * and `get_tabs` returned every live view, so two conversations running browser
 * tools at the same time saw (and could drive) each other's tabs: task B's
 * `get_tabs` listed task A's tab, and task A's click silently moved the "current
 * tab" out from under task B.
 *
 * The contract under test (ownership-semantics.md):
 *  1. ownerKey = `payload.ownerId` (a conversation id) or `'legacy'`.
 *  2. Views carry `{ ownerKey, createdAt }`; user-opened pane tabs are legacy.
 *  3. `get_tabs`: an owner sees its own + legacy tabs; a legacy caller sees only
 *     legacy tabs.
 *  4. The "current tab" is per owner, not global.
 *  5. Touching another owner's tab fails loud with a next-step hint.
 *  6. An empty (filtered) tab set creates a view for THAT owner.
 *
 * browserHost.cjs is a main-process module (`require('electron')` +
 * `require('./tauriHost.cjs')`), so this runs it under plain Node with both of
 * those cache slots pre-filled by fakes — same technique as
 * `updaterHost.test.cjs`'s `loadUpdaterHostWithFakeApp`.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const electronId = require.resolve('electron');
const tauriHostId = require.resolve('./tauriHost.cjs');
const browserHostId = require.resolve('./browserHost.cjs');

const OWNER_A = 'conversation-a';
const OWNER_B = 'conversation-b';

let nextContentsId = 100;
/** webContents.id -> fake instance, so tests can fire native events on a tab. */
const contentsRegistry = new Map();

class FakeWebContents {
  constructor() {
    this.id = (nextContentsId += 1);
    contentsRegistry.set(this.id, this);
    this.url = 'about:blank';
    this.title = 'Blank';
    this.destroyed = false;
    this.listeners = new Map();
    this.navigationHistory = { goBack() {}, goForward() {} };
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return this;
  }

  once(event, handler) {
    return this.on(event, handler);
  }

  fire(event, ...args) {
    for (const handler of this.listeners.get(event) || []) handler(...args);
  }

  setWindowOpenHandler() {}
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  focus() {}
  reload() {}
  close() { this.destroyed = true; }

  async loadURL(url) {
    this.url = url;
    return undefined;
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

function fakeSession() {
  return {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    setDevicePermissionHandler() {},
    setDisplayMediaRequestHandler() {},
    on() {},
  };
}

/**
 * Load a fresh browserHost bound to fake `electron` / `tauriHost` modules.
 * `emitEvent` plays the renderer: it adopts `browser://automation-open` by
 * calling `browser_create` with the same id, which is exactly what
 * `App.tsx` → `previewStore.openBrowser()` does in production.
 */
function loadHost({ adopt = true } = {}) {
  const prevElectron = require.cache[electronId];
  const prevTauri = require.cache[tauriHostId];
  delete require.cache[browserHostId];

  const emitted = [];
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { id: 1 },
    contentView: { addChildView() {}, removeChildView() {} },
  };
  let host = null;

  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: {
      WebContentsView: FakeWebContentsView,
      session: { fromPartition: () => fakeSession() },
    },
  };
  require.cache[tauriHostId] = {
    id: tauriHostId,
    filename: tauriHostId,
    loaded: true,
    exports: {
      emitEvent(event, payload) {
        emitted.push({ event, payload });
        if (adopt && event === 'browser://automation-open') {
          host.browserDispatch(null, 'browser_create', {
            id: payload.id,
            url: 'about:blank',
            x: 0,
            y: 0,
            width: 800,
            height: 600,
          });
        }
      },
      getMainWindow: () => mainWindow,
    },
  };

  host = require('./browserHost.cjs');

  const restore = () => {
    if (prevElectron) require.cache[electronId] = prevElectron;
    else delete require.cache[electronId];
    if (prevTauri) require.cache[tauriHostId] = prevTauri;
    else delete require.cache[tauriHostId];
    delete require.cache[browserHostId];
  };

  return { host, emitted, restore };
}

function getTabs(host, ownerId) {
  return host.performBrowserAutomation('get_tabs', ownerId ? { ownerId } : {});
}

function tabIds(result) {
  return result.windows[0].tabs.map((tab) => tab.tabId);
}

function navigate(host, ownerId, tabId, url) {
  return host.performBrowserAutomation('navigate', {
    ...(ownerId ? { ownerId } : {}),
    tabId,
    action: 'goto',
    url,
  });
}

/** Reach the fake webContents behind a tabId so tests can fire native events. */
function contentsFor(tabId) {
  const found = contentsRegistry.get(tabId);
  assert.ok(found, `no fake webContents for tab ${tabId}`);
  return found;
}

test('get_tabs isolates two conversations from each other', async () => {
  const { host, restore } = loadHost();
  try {
    const aTabs = await getTabs(host, OWNER_A);
    const bTabs = await getTabs(host, OWNER_B);

    assert.equal(tabIds(aTabs).length, 1);
    assert.equal(tabIds(bTabs).length, 1);
    assert.notEqual(tabIds(aTabs)[0], tabIds(bTabs)[0]);

    // B's tab must not leak into a later A listing (and vice versa).
    const aAgain = await getTabs(host, OWNER_A);
    assert.deepEqual(tabIds(aAgain), tabIds(aTabs));
    const bAgain = await getTabs(host, OWNER_B);
    assert.deepEqual(tabIds(bAgain), tabIds(bTabs));
  } finally {
    restore();
  }
});

test('acting on another conversation\'s tab fails loud with a next-step hint', async () => {
  const { host, restore } = loadHost();
  try {
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    await getTabs(host, OWNER_B);

    await assert.rejects(
      navigate(host, OWNER_B, aTab, 'https://example.com/'),
      (error) => {
        assert.equal(
          error.message,
          `Browser tab ${aTab} belongs to another conversation's task. ` +
            'Call get_tabs to see your own tabs, or open a new tab with navigate.'
        );
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('a legacy caller never sees an owned tab', async () => {
  const { host, restore } = loadHost();
  try {
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];

    const legacy = await getTabs(host);
    assert.equal(tabIds(legacy).includes(aTab), false);
    assert.equal(tabIds(legacy).length, 1);
    assert.equal(legacy.summary.currentTabId, tabIds(legacy)[0]);
  } finally {
    restore();
  }
});

test('an owner may drive a legacy pane tab without claiming it', async () => {
  const { host, restore } = loadHost();
  try {
    // A tab the user opened in the browser pane — never owned by a task.
    host.browserDispatch(null, 'browser_create', {
      id: 'pane-tab-1',
      url: 'https://example.com/',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });

    const legacyTabs = await getTabs(host);
    assert.equal(tabIds(legacyTabs).length, 1, 'a live legacy tab must not trigger a new view');
    const paneTabId = tabIds(legacyTabs)[0];

    // The owner sees the legacy tab, so no owned view gets created either.
    const aTabs = await getTabs(host, OWNER_A);
    assert.deepEqual(tabIds(aTabs), [paneTabId]);

    await navigate(host, OWNER_A, paneTabId, 'https://example.org/');

    // Ownership is unchanged: another owner and a legacy caller both still see it.
    const bTabs = await getTabs(host, OWNER_B);
    assert.deepEqual(tabIds(bTabs), [paneTabId]);
    const legacyAfter = await getTabs(host);
    assert.deepEqual(tabIds(legacyAfter), [paneTabId]);
  } finally {
    restore();
  }
});

test('one conversation\'s action does not move another conversation\'s current tab', async () => {
  const { host, restore } = loadHost();
  try {
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    const bBefore = await getTabs(host, OWNER_B);
    const bTab = bBefore.summary.currentTabId;
    assert.notEqual(bTab, aTab);

    await navigate(host, OWNER_A, aTab, 'https://example.com/');

    const bAfter = await getTabs(host, OWNER_B);
    assert.equal(bAfter.summary.currentTabId, bTab);
    assert.equal(bAfter.windows[0].tabs.find((tab) => tab.tabId === bTab)?.isCurrentTab, true);

    // A's own current tab did follow its action.
    const aAfter = await getTabs(host, OWNER_A);
    assert.equal(aAfter.summary.currentTabId, aTab);
    assert.equal(aAfter.summary.currentTabUrl, 'https://example.com/');
  } finally {
    restore();
  }
});

test('user focus updates only the focused tab owner\'s current tab', async () => {
  const { host, restore } = loadHost();
  try {
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    const bTab = tabIds(await getTabs(host, OWNER_B))[0];
    assert.notEqual(bTab, aTab);

    contentsFor(aTab).fire('focus');

    assert.equal((await getTabs(host, OWNER_A)).summary.currentTabId, aTab);
    assert.equal((await getTabs(host, OWNER_B)).summary.currentTabId, bTab);
  } finally {
    restore();
  }
});

test('a destroyed view drops its ownership record', async () => {
  const { host, restore } = loadHost();
  try {
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    const contents = contentsFor(aTab);
    contents.destroyed = true;
    contents.fire('destroyed');

    const aAfter = await getTabs(host, OWNER_A);
    assert.equal(tabIds(aAfter).length, 1);
    assert.notEqual(tabIds(aAfter)[0], aTab, 'a fresh owned view replaces the destroyed one');
    assert.equal(aAfter.summary.currentTabId, tabIds(aAfter)[0]);
  } finally {
    restore();
  }
});
