'use strict';

/**
 * browserHost — per-conversation tab ownership, and backing off when the user
 * takes the page over.
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
 * The takeover contract (R4) is layered on top of the same ownership keys:
 *  7. Keyboard input / focus landing on a view while no automation action is
 *     running is the USER, recorded against that view's owner; the same events
 *     fired by automation itself (keyboard's focus + sendInputEvent) are not.
 *  8. A state-changing action (click/fill/select/keyboard/navigate/execute_js/
 *     scroll/start_recording) waits for a 3s quiet window before running, and
 *     gives up after 10s with a fixed "the user is interacting" message.
 *     Read-only actions never wait.
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
    this.isolatedScripts = [];
    this.debugger = {
      isAttached: () => false,
      attach() {},
      detach() {},
      async sendCommand() { return { data: 'AAAA', cssContentSize: { width: 10, height: 10 } }; },
    };
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

  /** Electron focuses the real webContents here, which fires its `focus` event. */
  focus() { this.fire('focus'); }

  sendInputEvent() {}
  reload() {}
  close() { this.destroyed = true; }

  async loadURL(url) {
    this.url = url;
    return undefined;
  }

  async executeJavaScriptInIsolatedWorld(_worldId, scripts) {
    this.isolatedScripts.push(scripts);
    // `drainSelections` is the only inspect call whose return value matters
    // here; an empty drain keeps the session armed without emitting.
    return [];
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

/** A read-only listing: never provisions a view for an owner that has none. */
function probeTabs(host, ownerId) {
  return host.performBrowserAutomation('get_tabs', {
    ...(ownerId ? { ownerId } : {}),
    createIfEmpty: false,
  });
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

/**
 * The takeover backoff is a real-time wait (up to 10s), so the tests drive it
 * through the module's injectable clock instead: `sleep()` advances virtual
 * time by exactly the polling interval and records it, and `onSleep` lets a
 * test simulate the user typing straight through the wait.
 */
function fakeClock(start = 1_000_000) {
  const state = { t: start, sleeps: [], onSleep: null };
  const clock = {
    now: () => state.t,
    async sleep(ms) {
      state.t += ms;
      state.sleeps.push(ms);
      if (state.onSleep) state.onSleep();
    },
  };
  return { state, clock };
}

const USER_TAKEOVER_MESSAGE =
  'The user is currently interacting with this browser tab. Automation paused to avoid ' +
  'conflicting with their input. Wait for them to finish, then re-read the page state ' +
  '(snapshot) before continuing.';

function typeInto(tabId) {
  contentsFor(tabId).fire('before-input-event', {}, { type: 'keyDown', key: 'a' });
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

test('get_tabs with createIfEmpty:false lists without provisioning a view', async () => {
  // The desktop app's browser permission gate resolves the target tab's origin
  // with an internal get_tabs BEFORE deciding whether the action is allowed.
  // If that query provisioned a view, a denied action would still have left a
  // phantom tab behind (and, via adoption, a visible one).
  const { host, emitted, restore } = loadHost();
  try {
    const probe = await probeTabs(host, OWNER_A);
    assert.deepEqual(tabIds(probe), [], 'an owner with no tabs gets an empty list');
    assert.equal(probe.summary.totalTabs, 0);
    assert.equal(probe.summary.currentTabId, null);
    assert.equal(
      emitted.some((entry) => entry.event === 'browser://automation-open'),
      false,
      'a read-only probe must not open an automation view'
    );

    // Once the owner really has a tab, the probe sees it like any other caller.
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A)), [aTab]);

    // ...and it still respects ownership: another conversation sees nothing.
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_B)), []);
  } finally {
    restore();
  }
});

test('get_tabs still provisions a view by default (unchanged for every other caller)', async () => {
  const { host, restore } = loadHost();
  try {
    assert.equal(tabIds(await getTabs(host, OWNER_A)).length, 1);
    assert.equal(tabIds(await host.performBrowserAutomation('get_tabs', {})).length, 1);
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

test('a headless fallback view still belongs to the requesting conversation', async () => {
  // No renderer answers `browser://automation-open`, so createAutomationView
  // falls through its bounded wait and builds the hidden view itself. That
  // branch has its own meta / active-tab / pending-map writes which the
  // adoption path never executes.
  const { host, emitted, restore } = loadHost({ adopt: false });
  try {
    const aTabs = await getTabs(host, OWNER_A);
    const openEvent = emitted.find((entry) => entry.event === 'browser://automation-open');
    assert.ok(openEvent, 'the automation-open event fires even with no renderer listening');
    const fallbackId = openEvent.payload.id;
    const aTab = tabIds(aTabs)[0];

    // The fallback view is recorded as the requesting owner's current tab...
    assert.equal(aTabs.summary.currentTabId, aTab);
    // ...and its meta says OWNER_A owns it — a legacy view would let B through.
    await assert.rejects(navigate(host, OWNER_B, aTab, 'https://example.com/'), (error) => {
      assert.match(error.message, /belongs to another conversation's task/);
      return true;
    });

    // The pending-owner entry was consumed by the fallback. Probe it: dropping
    // the view clears viewMeta but never touches the pending map, so
    // re-creating the SAME id as a user pane tab would come back OWNER_A-owned
    // (and invisible to a legacy caller) if the entry had been stranded.
    const contents = contentsFor(aTab);
    contents.destroyed = true;
    contents.fire('destroyed');
    host.browserDispatch(null, 'browser_create', {
      id: fallbackId,
      url: 'https://example.com/',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });

    const legacyTabs = await getTabs(host);
    assert.equal(tabIds(legacyTabs).length, 1);
    assert.equal(legacyTabs.windows[0].tabs[0].url, 'https://example.com/');
  } finally {
    restore();
  }
});

test('a state-changing action waits out the user\'s input, then proceeds', async () => {
  const { host, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];

    typeInto(aTab);
    state.t += 2000; // 2s into the 3s quiet window — still "hands on keyboard"

    await navigate(host, OWNER_A, aTab, 'https://example.com/');

    assert.deepEqual(state.sleeps, [500, 500], 'polled twice, then the window went quiet');
    assert.equal(contentsFor(aTab).url, 'https://example.com/', 'the action ran after the wait');
  } finally {
    restore();
  }
});

test('a state-changing action gives up with the pause message if the user never stops', async () => {
  const { host, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];

    typeInto(aTab);
    // The user keeps typing through every poll — the recording must survive the
    // wait, i.e. the wait itself must not be inside the AI-attribution window.
    state.onSleep = () => typeInto(aTab);

    await assert.rejects(navigate(host, OWNER_A, aTab, 'https://example.com/'), (error) => {
      assert.equal(error.message, USER_TAKEOVER_MESSAGE);
      return true;
    });

    assert.equal(state.sleeps.length, 20, '10s of 500ms polls, then it stops trying');
    assert.equal(contentsFor(aTab).url, 'about:blank', 'the action never ran');
  } finally {
    restore();
  }
});

test('read-only actions are never held back by user interaction', async () => {
  const { host, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];

    typeInto(aTab); // the user is mid-keystroke right now

    const shot = await host.performBrowserAutomation('screenshot', {
      ownerId: OWNER_A,
      tabId: aTab,
    });
    assert.match(shot, /^data:image\/png;base64,/);
    const tabs = await getTabs(host, OWNER_A);
    assert.deepEqual(tabIds(tabs), [aTab]);

    assert.deepEqual(state.sleeps, [], 'reading the page never waits on the user');
  } finally {
    restore();
  }
});

test('automation\'s own focus and input do not count as user interaction', async () => {
  const { host, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];

    // `keyboard` focuses the webContents and injects key events — all of it
    // inside the AI-attribution window, so none of it is the user.
    await host.performBrowserAutomation('keyboard', { ownerId: OWNER_A, tabId: aTab, key: 'a' });
    await navigate(host, OWNER_A, aTab, 'https://example.com/');
    assert.deepEqual(state.sleeps, [], 'automation must not back off from itself');

    // The same event, fired while no action is running, IS the user.
    contentsFor(aTab).fire('focus');
    await navigate(host, OWNER_A, aTab, 'https://example.org/');
    assert.equal(state.sleeps.length, 6, 'waited out the full 3s quiet window');
    assert.equal(contentsFor(aTab).url, 'https://example.org/');
  } finally {
    restore();
  }
});

test('an armed inspect session backs automation off like live input', async () => {
  const { host, emitted, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    const viewId = emitted.find((entry) => entry.event === 'browser://automation-open').payload.id;

    // The user is picking an element in this very view.
    await host.browserDispatch(null, 'browser_inspect_set', { id: viewId, enabled: true });

    await assert.rejects(navigate(host, OWNER_A, aTab, 'https://example.com/'), (error) => {
      assert.equal(error.message, USER_TAKEOVER_MESSAGE);
      return true;
    });
    assert.equal(state.sleeps.length, 20);

    // Disarmed (also clears the poll timer, which would otherwise outlive the test).
    await host.browserDispatch(null, 'browser_inspect_set', { id: viewId, enabled: false });
    state.sleeps.length = 0;
    await navigate(host, OWNER_A, aTab, 'https://example.com/');
    assert.deepEqual(state.sleeps, []);
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
