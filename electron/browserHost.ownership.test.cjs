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

  /**
   * Electron tears the contents down and fires `destroyed`, which is where
   * browserHost drops the per-view ownership records (`browser_close` itself
   * only removes the view). A fake that flipped the flag without the event
   * would leave every test looking at state production never has.
   */
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.fire('destroyed');
  }

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

/**
 * `onHeadersReceived` is invoked once per loadHost() (browserSessionForViews()
 * is memoized inside the fresh module instance), and the real signature is
 * `(filter, listener)` where the listener takes `(details, callback)`. The
 * `capture` hook lets a test grab that listener so it can fire synthetic
 * main-frame 429/2xx responses without a real network round trip.
 */
function fakeSession(capture) {
  return {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    setDevicePermissionHandler() {},
    setDisplayMediaRequestHandler() {},
    on() {},
    webRequest: {
      onHeadersReceived(_filter, listener) {
        if (capture) capture(listener);
      },
    },
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
  let webRequestListener = null;

  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: {
      WebContentsView: FakeWebContentsView,
      session: {
        fromPartition: () => fakeSession((listener) => { webRequestListener = listener; }),
      },
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

  /**
   * Fire a synthetic `webRequest.onHeadersReceived` event, as if `browserSession`
   * had just observed a real response. `webRequestListener` is only populated
   * once something has actually created the browser session (e.g. a `get_tabs`
   * call has provisioned a view) — callers must do that first.
   */
  const fireHeadersReceived = (details) => {
    if (!webRequestListener) throw new Error('webRequest listener not registered yet');
    webRequestListener({ resourceType: 'mainFrame', ...details }, () => {});
  };

  return { host, emitted, restore, fireHeadersReceived };
}

function getTabs(host, ownerId, runId) {
  return host.performBrowserAutomation('get_tabs', {
    ...(ownerId ? { ownerId } : {}),
    ...(runId ? { runId } : {}),
  });
}

/** A read-only listing: never provisions a view for an owner that has none. */
function probeTabs(host, ownerId, runId) {
  return host.performBrowserAutomation('get_tabs', {
    ...(ownerId ? { ownerId } : {}),
    ...(runId ? { runId } : {}),
    createIfEmpty: false,
  });
}

function tabIds(result) {
  return result.windows[0].tabs.map((tab) => tab.tabId);
}

function navigate(host, ownerId, tabId, url, runId) {
  return host.performBrowserAutomation('navigate', {
    ...(ownerId ? { ownerId } : {}),
    ...(runId ? { runId } : {}),
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

test('browser://automation-open carries the owner so the renderer can route the tab', async () => {
  // Without this the renderer has no way to tell whose tab it just adopted, so
  // a background conversation's view lands in whatever conversation the user is
  // currently looking at.
  const { host, emitted, restore } = loadHost();
  try {
    await getTabs(host, OWNER_A);
    const owned = emitted.filter((entry) => entry.event === 'browser://automation-open');
    assert.equal(owned.length, 1);
    assert.equal(owned[0].payload.ownerId, OWNER_A);

    // A caller that sends no owner is the legacy shared pool: no ownerId at
    // all, so every conversation may see the tab (today's behavior).
    await host.performBrowserAutomation('get_tabs', {});
    const all = emitted.filter((entry) => entry.event === 'browser://automation-open');
    assert.equal(all.length, 2);
    assert.equal('ownerId' in all[1].payload, false);
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

/**
 * R5 — exponential per-origin backoff after HTTP 429 (docs at the top of
 * `originBackoff` in browserHost.cjs). All of these fire the fake
 * `webRequest.onHeadersReceived` listener directly rather than going through
 * a real navigation, since the fake WebContents has no real network stack.
 */
function respond(fireHeadersReceived, url, statusCode, resourceType) {
  fireHeadersReceived({ url, statusCode, ...(resourceType ? { resourceType } : {}) });
}

test('a 429 on the current origin blocks a state-changing action with the seconds remaining', async () => {
  const { host, fireHeadersReceived, restore } = loadHost();
  try {
    const { clock } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    await navigate(host, OWNER_A, aTab, 'https://example.com/checkout');

    respond(fireHeadersReceived, 'https://example.com/checkout', 429);

    await assert.rejects(
      navigate(host, OWNER_A, aTab, 'https://example.com/checkout?retry=1'),
      (error) => {
        assert.equal(
          error.message,
          'This site is rate-limiting automated actions (HTTP 429). Backing off for 1s — ' +
            'retrying immediately would make it worse. Tell the user, wait, or suggest they do this step manually.'
        );
        return true;
      }
    );
    // No retry: the action must not have run.
    assert.equal(contentsFor(aTab).url, 'https://example.com/checkout');
  } finally {
    restore();
  }
});

test('read-only actions are never blocked by an origin backoff', async () => {
  const { host, fireHeadersReceived, restore } = loadHost();
  try {
    const { clock } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    await navigate(host, OWNER_A, aTab, 'https://example.com/');

    respond(fireHeadersReceived, 'https://example.com/', 429);

    const shot = await host.performBrowserAutomation('screenshot', { ownerId: OWNER_A, tabId: aTab });
    assert.match(shot, /^data:image\/png;base64,/);
  } finally {
    restore();
  }
});

test('a backoff window expires on its own and the action is then allowed', async () => {
  const { host, fireHeadersReceived, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    await navigate(host, OWNER_A, aTab, 'https://example.com/');

    respond(fireHeadersReceived, 'https://example.com/', 429);
    state.t += 1000; // exactly the 1s (level-1) window — now expired

    await navigate(host, OWNER_A, aTab, 'https://example.com/next');
    assert.equal(contentsFor(aTab).url, 'https://example.com/next', 'the action ran once the window expired');
  } finally {
    restore();
  }
});

test('consecutive 429s escalate exponentially and cap at 30s', async () => {
  const { host, fireHeadersReceived, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    await navigate(host, OWNER_A, aTab, 'https://example.com/');

    // Level 1: 1s.
    respond(fireHeadersReceived, 'https://example.com/', 429);
    await assert.rejects(navigate(host, OWNER_A, aTab, 'https://example.com/'), /Backing off for 1s/);

    // Level 2: 2s (a second 429 while still gated, before the first window even expires).
    respond(fireHeadersReceived, 'https://example.com/', 429);
    await assert.rejects(navigate(host, OWNER_A, aTab, 'https://example.com/'), /Backing off for 2s/);

    // Level 3: 4s.
    respond(fireHeadersReceived, 'https://example.com/', 429);
    await assert.rejects(navigate(host, OWNER_A, aTab, 'https://example.com/'), /Backing off for 4s/);

    // Keep hitting it until the delay would exceed 30s — it must stay capped.
    respond(fireHeadersReceived, 'https://example.com/', 429); // level 4: 8s
    respond(fireHeadersReceived, 'https://example.com/', 429); // level 5: 16s
    respond(fireHeadersReceived, 'https://example.com/', 429); // level 6: would be 32s, capped to 30s
    await assert.rejects(navigate(host, OWNER_A, aTab, 'https://example.com/'), /Backing off for 30s/);

    state.t += 30000;
    await navigate(host, OWNER_A, aTab, 'https://example.com/done');
    assert.equal(contentsFor(aTab).url, 'https://example.com/done');
  } finally {
    restore();
  }
});

test('a 2xx main-frame response clears that origin\'s backoff window', async () => {
  const { host, fireHeadersReceived, restore } = loadHost();
  try {
    const { clock } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    await navigate(host, OWNER_A, aTab, 'https://example.com/');

    respond(fireHeadersReceived, 'https://example.com/', 429);
    await assert.rejects(navigate(host, OWNER_A, aTab, 'https://example.com/'), /Backing off/);

    respond(fireHeadersReceived, 'https://example.com/', 200);
    await navigate(host, OWNER_A, aTab, 'https://example.com/after-clear');
    assert.equal(contentsFor(aTab).url, 'https://example.com/after-clear');
  } finally {
    restore();
  }
});

test('a 429 returned after a redirect is attributed to the post-redirect origin, not the pre-redirect one', async () => {
  // Electron's webRequest fires onHeadersReceived once per hop of a
  // navigation, each carrying THAT hop's own response URL — a redirect
  // Y -> X therefore fires twice: once for Y's 3xx, once for X's final
  // response. Simulate exactly that shape and confirm the backoff lands on
  // X (the origin that actually answered 429), not Y (the one the agent
  // originally asked to visit).
  const { host, fireHeadersReceived, restore } = loadHost();
  try {
    const { clock } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    await navigate(host, OWNER_A, aTab, 'https://y.example.com/start');

    respond(fireHeadersReceived, 'https://y.example.com/start', 302); // redirect hop from Y
    respond(fireHeadersReceived, 'https://x.example.com/final', 429); // final hop from X

    // The redirect landed the tab on X — driven directly on the fake
    // webContents, exactly like a real redirect: Chromium's OWN navigation
    // engine follows a 3xx without ever re-entering the automation gate (only
    // the ORIGINAL `goto` call from the agent goes through it). Routing this
    // through another `navigate()` call would (correctly, per I-1) get
    // blocked as a fresh navigation INTO the now-backed-off X — which is not
    // what is being simulated here.
    await contentsFor(aTab).loadURL('https://x.example.com/final');

    // A further gated action on that (now X-origin) tab is blocked.
    await assert.rejects(
      navigate(host, OWNER_A, aTab, 'https://x.example.com/final?retry=1'),
      /Backing off for 1s/
    );
    assert.equal(contentsFor(aTab).url, 'https://x.example.com/final', 'no retry landed');

    // A second, unrelated tab still on Y's origin is unaffected — the backoff
    // must be keyed by X, not by Y (nor by anything else the redirect touched).
    const bTab = tabIds(await getTabs(host, OWNER_B))[0];
    await navigate(host, OWNER_B, bTab, 'https://y.example.com/other-page');
    await navigate(host, OWNER_B, bTab, 'https://y.example.com/still-fine');
    assert.equal(contentsFor(bTab).url, 'https://y.example.com/still-fine');
  } finally {
    restore();
  }
});

test('a 429 on a subresource (non-main-frame) is not treated as the page rate-limiting', async () => {
  const { host, fireHeadersReceived, restore } = loadHost();
  try {
    const { clock } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    await navigate(host, OWNER_A, aTab, 'https://example.com/');

    respond(fireHeadersReceived, 'https://example.com/ads/tracker.js', 429, 'script');

    await navigate(host, OWNER_A, aTab, 'https://example.com/still-fine');
    assert.equal(contentsFor(aTab).url, 'https://example.com/still-fine');
  } finally {
    restore();
  }
});

/**
 * I-1 — the R5 gate must check the NAVIGATION TARGET's origin, not the tab's
 * current origin, for a `navigate`/`goto` action. Checking the current origin
 * (the pre-fix behavior) gets both directions wrong: it lets automation
 * navigate FROM a clean tab INTO a backed-off origin (missed block), and it
 * traps a tab that happens to be sitting ON a backed-off origin so it can
 * never navigate away to safety (false block, and the escape hatch — leaving
 * the bad site — is exactly what should NOT be gated).
 */
test('navigating INTO a backed-off origin is blocked, even from a clean tab', async () => {
  const { host, fireHeadersReceived, restore } = loadHost();
  try {
    const { clock } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    await navigate(host, OWNER_A, aTab, 'https://y.example.com/');

    respond(fireHeadersReceived, 'https://x.example.com/', 429);

    await assert.rejects(
      navigate(host, OWNER_A, aTab, 'https://x.example.com/'),
      /Backing off for 1s/
    );
    assert.equal(contentsFor(aTab).url, 'https://y.example.com/', 'the navigation to x.com never happened');
  } finally {
    restore();
  }
});

test('navigating AWAY FROM a backed-off origin is the escape hatch and is never gated', async () => {
  const { host, fireHeadersReceived, restore } = loadHost();
  try {
    const { clock } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    await navigate(host, OWNER_A, aTab, 'https://x.example.com/');

    respond(fireHeadersReceived, 'https://x.example.com/', 429);

    await navigate(host, OWNER_A, aTab, 'https://y.example.com/');
    assert.equal(contentsFor(aTab).url, 'https://y.example.com/', 'leaving the backed-off origin is allowed');
  } finally {
    restore();
  }
});

test('an in-page action on a backed-off origin still uses the current-origin check', async () => {
  const { host, fireHeadersReceived, restore } = loadHost();
  try {
    const { clock } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    await navigate(host, OWNER_A, aTab, 'https://x.example.com/');

    respond(fireHeadersReceived, 'https://x.example.com/', 429);

    await assert.rejects(
      host.performBrowserAutomation('click', {
        ownerId: OWNER_A,
        tabId: aTab,
        selector: '#submit',
      }),
      /Backing off for 1s/
    );
  } finally {
    restore();
  }
});

/**
 * Abort-to-main: the MCP loopback server aborts an AbortController when the
 * client request closes early (see browserAutomationHost.cjs's `handleRequest`),
 * and threads it through `performBrowserAutomation(action, payload, { signal })`
 * into whatever gated wait the action is sitting in.
 */
test('an aborted signal stops a gated action during the user-idle wait, within one poll', async () => {
  const { host, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];

    typeInto(aTab); // the user is mid-keystroke, so the gated wait actually starts
    const controller = new AbortController();
    // Simulate the run being stopped mid-wait — the request closes, which is
    // exactly what fires between two polls in the real handler.
    state.onSleep = () => controller.abort();

    await assert.rejects(
      host.performBrowserAutomation(
        'navigate',
        { ownerId: OWNER_A, tabId: aTab, action: 'goto', url: 'https://example.com/' },
        { signal: controller.signal }
      ),
      (error) => {
        assert.equal(error.message, 'Browser action cancelled because the run was stopped.');
        return true;
      }
    );

    assert.equal(state.sleeps.length, 1, 'stopped after the very next poll, not the full 10s wait');
    assert.equal(contentsFor(aTab).url, 'about:blank', 'the aborted action never landed');
  } finally {
    restore();
  }
});

test('a pre-aborted signal is honored even before the rate-limit gate runs', async () => {
  const { host, restore } = loadHost();
  try {
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      host.performBrowserAutomation(
        'navigate',
        { ownerId: OWNER_A, tabId: aTab, action: 'goto', url: 'https://example.com/' },
        { signal: controller.signal }
      ),
      /Browser action cancelled because the run was stopped\./
    );
    assert.equal(contentsFor(aTab).url, 'about:blank');
  } finally {
    restore();
  }
});

/**
 * I-3 — `get_tabs`/`get_downloads` sit entirely outside `TAKEOVER_GATED_ACTIONS`
 * (they are read-only, and `get_tabs` is the one action that PROVISIONS a tab
 * for an owner that has none), so the per-gate `assertNotAborted` never ran for
 * them. A Stop mid-flight could still land after the abort, opening a brand new
 * tab for a run that no longer exists. `assertNotAborted` at the very top of
 * `runBrowserAutomation` closes that gap for every action, gated or not.
 */
test('a pre-aborted signal stops get_tabs before it can provision or open a tab', async () => {
  const { host, emitted, restore } = loadHost();
  try {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      host.performBrowserAutomation('get_tabs', { ownerId: OWNER_A }, { signal: controller.signal }),
      /Browser action cancelled because the run was stopped\./
    );

    assert.equal(
      emitted.some((entry) => entry.event === 'browser://automation-open'),
      false,
      'an aborted get_tabs must not open a new automation view'
    );
    // Confirm no view exists for OWNER_A at all (a live, un-aborted get_tabs
    // would have provisioned exactly one).
    const probe = await probeTabs(host, OWNER_A);
    assert.deepEqual(tabIds(probe), []);
  } finally {
    restore();
  }
});

/**
 * N3 — the React layer (address bar, back/forward/reload) never touches the
 * guest webContents, so it produces none of the `before-input-event`/`focus`
 * signals R4's backoff relies on. `browser_note_user_interaction` is the
 * bridge: `BrowserTab.tsx` calls it on address-bar focus/input and nav-button
 * clicks, and it must gate a state-changing action exactly like real
 * `before-input-event`/`focus` input does (reusing the same `userInteractionAt`
 * record — see `typeInto`-driven scenarios above).
 */
test('browser_note_user_interaction gates a state-changing action like real input does', async () => {
  const { host, emitted, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    // `browser_note_user_interaction` takes the view's own string id — same
    // as `browser_create`/`browser_inspect_set` — NOT the automation `tabId`
    // (the guest's numeric webContents id) that `navigate`/`get_tabs` use.
    const viewId = emitted.find((entry) => entry.event === 'browser://automation-open').payload.id;

    host.browserDispatch(null, 'browser_note_user_interaction', { id: viewId });
    state.t += 2000; // 2s into the 3s quiet window — still "hands on keyboard"

    await navigate(host, OWNER_A, aTab, 'https://example.com/');

    assert.deepEqual(state.sleeps, [500, 500], 'polled twice, then the window went quiet');
    assert.equal(contentsFor(aTab).url, 'https://example.com/', 'the action ran after the wait');
  } finally {
    restore();
  }
});

/**
 * N4 — `browser_dispose_owner`.
 *
 * A conversation used to be able to disappear (the user deletes it) while its
 * agent's browser views kept running: no tab strip listed them any more, so
 * nothing could close them, and main held a live WebContentsView per deleted
 * conversation for the rest of the session. The renderer's delete cascade now
 * drops those tab records (which destroys their views) AND sends this command,
 * which is the only path that can reach main-side state the renderer has no
 * tab record for — a headless fallback view, or a view adopted after the tab
 * record was already gone.
 */
test('browser_dispose_owner closes every view the deleted conversation owned, and nothing else', async () => {
  // Two owned views for OWNER_A: with no renderer answering
  // `browser://automation-open`, two concurrent provisioning calls both see an
  // empty tab set and both fall through to the headless fallback branch — the
  // branch whose views the renderer has no record of at all.
  const { host, restore } = loadHost({ adopt: false });
  try {
    const [aFirst, aSecond, bTabs] = await Promise.all([
      getTabs(host, OWNER_A),
      getTabs(host, OWNER_A),
      getTabs(host, OWNER_B),
    ]);
    const aTab1 = tabIds(aFirst)[0];
    const aTab2 = tabIds(aSecond)[0];
    const bTab = tabIds(bTabs)[0];
    assert.notEqual(aTab1, aTab2, 'the owner really has two views to dispose');

    // A tab the user opened in the pane — legacy, shared, and never a
    // conversation's to dispose.
    host.browserDispatch(null, 'browser_create', {
      id: 'pane-tab-1',
      url: 'https://example.com/',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    const paneTab = tabIds(await probeTabs(host))[0];

    host.browserDispatch(null, 'browser_dispose_owner', { conversationId: OWNER_A });

    assert.equal(contentsFor(aTab1).isDestroyed(), true);
    assert.equal(contentsFor(aTab2).isDestroyed(), true);
    assert.equal(contentsFor(bTab).isDestroyed(), false, 'another conversation keeps its tab');
    assert.equal(contentsFor(paneTab).isDestroyed(), false, 'the user pane tab survives');

    // Neither view is listed any more; the other owner's current tab is intact.
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A)), [paneTab]);
    const bAfter = await probeTabs(host, OWNER_B);
    assert.deepEqual(tabIds(bAfter).sort(), [bTab, paneTab].sort());
    assert.equal(bAfter.summary.currentTabId, bTab);
  } finally {
    restore();
  }
});

test('browser_dispose_owner leaves no ownership state behind for the deleted conversation', async () => {
  const { host, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    typeInto(aTab); // the user was typing in that tab a moment ago

    host.browserDispatch(null, 'browser_dispose_owner', { conversationId: OWNER_A });

    // The current-tab record is gone: a read-only probe reports no tab at all,
    // not a destroyed one.
    const probe = await probeTabs(host, OWNER_A);
    assert.deepEqual(tabIds(probe), []);
    assert.equal(probe.summary.currentTabId, null);

    // The interaction record is gone too: virtual time never advanced, so a
    // surviving timestamp would still be inside the 3s quiet window and hold
    // this action back for the full 10s wait.
    const fresh = tabIds(await getTabs(host, OWNER_A))[0];
    await navigate(host, OWNER_A, fresh, 'https://example.com/');
    assert.deepEqual(state.sleeps, [], 'no stale takeover record survived the dispose');
  } finally {
    restore();
  }
});

test('disposing an owner twice, or closing a disposed view, is harmless', async () => {
  // The renderer removes the tab records (each firing `browser_close`) AND
  // sends the dispose command; the two race, so every combination must be a
  // no-op after the first one lands.
  const { host, emitted, restore } = loadHost();
  try {
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    const viewId = emitted.find((entry) => entry.event === 'browser://automation-open').payload.id;

    host.browserDispatch(null, 'browser_dispose_owner', { conversationId: OWNER_A });
    host.browserDispatch(null, 'browser_dispose_owner', { conversationId: OWNER_A });
    assert.equal(host.browserDispatch(null, 'browser_close', { id: viewId }), null);

    assert.equal(contentsFor(aTab).isDestroyed(), true);
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A)), []);
  } finally {
    restore();
  }
});

test('browser_dispose_owner never reaps the legacy shared pool', async () => {
  const { host, restore } = loadHost();
  try {
    host.browserDispatch(null, 'browser_create', {
      id: 'pane-tab-1',
      url: 'https://example.com/',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    const paneTab = tabIds(await probeTabs(host))[0];

    for (const conversationId of ['legacy', '', '   ', undefined, 42]) {
      assert.equal(host.browserDispatch(null, 'browser_dispose_owner', { conversationId }), null);
    }

    assert.equal(contentsFor(paneTab).isDestroyed(), false);
    assert.deepEqual(tabIds(await probeTabs(host)), [paneTab]);
  } finally {
    restore();
  }
});

/**
 * N8 — the adoption wait had no abort check, so a run stopped while main was
 * waiting for the renderer to adopt still sat out the full 2.5s and then built
 * a hidden fallback view for a run that no longer existed.
 */
test('a stop during the adoption wait cancels it instead of stranding a hidden view', async () => {
  const { host, emitted, restore } = loadHost({ adopt: false });
  try {
    const controller = new AbortController();
    const pending = host.performBrowserAutomation(
      'get_tabs',
      { ownerId: OWNER_A },
      { signal: controller.signal },
    );
    // The call is already inside the adoption wait (the top-of-call abort
    // check ran before this line), so this is the real "Stop mid-wait" shape.
    controller.abort();

    await assert.rejects(pending, (error) => {
      assert.equal(error.message, 'Browser action cancelled because the run was stopped.');
      return true;
    });

    const openEvent = emitted.find((entry) => entry.event === 'browser://automation-open');
    assert.ok(openEvent, 'the wait had really started');
    // Running the wait out ALWAYS ends in a fallback view, so an empty owner
    // proves the loop exited on the abort rather than on its deadline.
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A)), []);

    // The invitation is withdrawn, both ways: the renderer is told to drop the
    // tab record, and a `browser_create` that was already in flight for that id
    // builds NOTHING. (Letting it through would create a legacy view — the
    // pending owner is gone — that every other conversation can see and drive,
    // while the only record able to destroy it carries the stopped run's owner
    // and is therefore invisible in every strip.)
    assert.deepEqual(
      emitted.filter((entry) => entry.event === 'browser://automation-cancel').map((e) => e.payload),
      [{ id: openEvent.payload.id }]
    );
    assert.equal(
      host.browserDispatch(null, 'browser_create', {
        id: openEvent.payload.id,
        url: 'https://example.com/',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      }),
      null,
      'a refused adoption resolves quietly — a throw would drive BrowserTab\'s create-retry loop'
    );
    assert.deepEqual(tabIds(await probeTabs(host)), [], 'no legacy ghost was created');
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_B)), [], 'and no other owner sees one');
  } finally {
    restore();
  }
});

/**
 * I1 (fix round 1) — the cancel/dispose paths drop the pending-owner entry while
 * `browser://automation-open` is already on its way out, and the renderer
 * answers it unconditionally with `browser_create`. Both orderings of that race
 * must end with no view and no record.
 */
test('a browser_create landing after a dispose cannot become a legacy ghost', async () => {
  const { host, emitted, restore } = loadHost({ adopt: false });
  try {
    // `browser://automation-open` is emitted before the wait's first await, so
    // it has already fired by the time this call yields its promise.
    const pending = host.performBrowserAutomation('get_tabs', { ownerId: OWNER_A });
    const openId = emitted.find((item) => item.event === 'browser://automation-open').payload.id;

    host.browserDispatch(null, 'browser_dispose_owner', { conversationId: OWNER_A });
    await assert.rejects(pending, /Browser action cancelled because the run was stopped\./);

    // The renderer's adoption arrives late — exactly the reproduced ghost.
    assert.equal(
      host.browserDispatch(null, 'browser_create', {
        id: openId,
        url: 'https://ghost.example/',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      }),
      null
    );

    assert.deepEqual(tabIds(await probeTabs(host, OWNER_B)), [], 'no ghost in another owner\'s tabs');
    assert.deepEqual(tabIds(await probeTabs(host)), [], 'and none in the legacy pool');
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A)), []);
    // Even a repeated create (StrictMode double-mount) stays refused.
    host.browserDispatch(null, 'browser_create', {
      id: openId,
      url: 'https://ghost.example/',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    assert.deepEqual(tabIds(await probeTabs(host)), []);
  } finally {
    restore();
  }
});

test('disposing an already-adopted view tells the renderer to drop its record', async () => {
  // The other ordering: the renderer adopted BEFORE the dispose landed, so the
  // tab record exists. Closing the view alone would leave that record behind —
  // invisible in every strip (it carries the deleted conversation's owner) and
  // still mounted, syncing bounds for a view that is gone.
  const { host, emitted, restore } = loadHost();
  try {
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];
    const viewId = emitted.find((entry) => entry.event === 'browser://automation-open').payload.id;

    host.browserDispatch(null, 'browser_dispose_owner', { conversationId: OWNER_A });

    assert.equal(contentsFor(aTab).isDestroyed(), true);
    assert.deepEqual(
      emitted.filter((entry) => entry.event === 'browser://automation-cancel').map((e) => e.payload),
      [{ id: viewId }]
    );
    // A create retry that was already in flight for that view is refused too.
    host.browserDispatch(null, 'browser_create', {
      id: viewId,
      url: 'https://retry.example/',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    assert.deepEqual(tabIds(await probeTabs(host)), []);
  } finally {
    restore();
  }
});

test('the cancelled-adoption tombstone set stays bounded', async () => {
  // It only has to outlive an in-flight adoption (milliseconds), so it is capped
  // and evicts oldest-first rather than growing for the life of the session.
  const { host, emitted, restore } = loadHost();
  try {
    const ids = [];
    for (let i = 0; i < 70; i += 1) {
      const owner = `conversation-bulk-${i}`;
      await getTabs(host, owner);
      ids.push(emitted[emitted.length - 1].payload.id);
      host.browserDispatch(null, 'browser_dispose_owner', { conversationId: owner });
    }

    // The newest cancellations are still refused...
    host.browserDispatch(null, 'browser_create', {
      id: ids[69], url: 'https://recent.example/', x: 0, y: 0, width: 800, height: 600,
    });
    assert.deepEqual(tabIds(await probeTabs(host)), [], 'a recent cancellation still blocks');

    // ...and the oldest have aged out, which is the bound itself: an adoption
    // 70 cancellations ago is long dead, so re-using its id is not a ghost path.
    host.browserDispatch(null, 'browser_create', {
      id: ids[0], url: 'https://aged-out.example/', x: 0, y: 0, width: 800, height: 600,
    });
    assert.equal(tabIds(await probeTabs(host)).length, 1, 'the set did not grow past its cap');
  } finally {
    restore();
  }
});

test('disposing an owner mid-adoption does not strand a fallback view for it', async () => {
  // The delete cascade can land while an automation call is still waiting for
  // adoption. Without the pending-entry check the wait would run to its
  // deadline and build a view for a conversation that no longer exists — the
  // exact orphan the dispose command is meant to prevent.
  const { host, emitted, restore } = loadHost({ adopt: false });
  try {
    const pending = host.performBrowserAutomation('get_tabs', { ownerId: OWNER_A });
    host.browserDispatch(null, 'browser_dispose_owner', { conversationId: OWNER_A });

    await assert.rejects(pending, (error) => {
      assert.equal(error.message, 'Browser action cancelled because the run was stopped.');
      return true;
    });
    assert.ok(emitted.some((entry) => entry.event === 'browser://automation-open'));
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A)), []);
  } finally {
    restore();
  }
});

test('browser_note_user_interaction on an unknown id is a silent no-op', async () => {
  const { host, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const aTab = tabIds(await getTabs(host, OWNER_A))[0];

    const result = host.browserDispatch(null, 'browser_note_user_interaction', { id: 'no-such-view' });
    assert.equal(result, null, 'unknown id resolves to null, not an error');

    // Nothing should have been recorded against any owner — the action runs
    // immediately with no wait.
    await navigate(host, OWNER_A, aTab, 'https://example.com/');
    assert.deepEqual(state.sleeps, []);
  } finally {
    restore();
  }
});

/**
 * ── N6 — ownership refined from "one conversation" to "one subagent run" ──
 *
 * A conversation can drive the browser from several places at once: its own
 * main loop, and any number of delegated subagent runs. With ownership keyed on
 * the conversation alone all of them shared one pool and one "current tab", so
 * two sibling subagents researching two different sites saw each other's tabs in
 * `get_tabs` and silently stole each other's current tab — the exact bug the
 * per-conversation keying fixed BETWEEN conversations, reproduced inside one.
 *
 * The owner is now the pair `{conversationId, runKey}`:
 *  - `runKey` comes from `payload.runId` (the `sar-*` subagent run id, threaded
 *    down through `_meta['abu/runKey']`); a caller that sends none — the main
 *    loop, and every pre-N6 caller — is `main`, so single-run behavior is
 *    byte-for-byte what it was.
 *  - `get_tabs` / current-tab / takeover records are all per pair.
 *  - An EXPLICIT tabId naming a sibling run's tab in the SAME conversation is
 *    allowed (that is how a parent hands a tab to a child: it puts the id in the
 *    task description); another CONVERSATION's tab still fails loud, with the
 *    message unchanged.
 *  - `browser_dispose_owner` takes an optional `runKey`: with it, exactly that
 *    run is reaped (a finished subagent releasing its tabs); without it, every
 *    run of that conversation is (the conversation was deleted) — the pre-N6
 *    behavior of that command.
 */

const RUN_1 = 'sar-run-one';
const RUN_2 = 'sar-run-two';

test('two subagent runs of the same conversation do not see each other tabs', async () => {
  const { host, restore } = loadHost();
  try {
    const run1 = await getTabs(host, OWNER_A, RUN_1);
    const run2 = await getTabs(host, OWNER_A, RUN_2);
    const mainLoop = await getTabs(host, OWNER_A);

    assert.equal(tabIds(run1).length, 1);
    assert.equal(tabIds(run2).length, 1);
    assert.equal(tabIds(mainLoop).length, 1);
    const distinct = new Set([tabIds(run1)[0], tabIds(run2)[0], tabIds(mainLoop)[0]]);
    assert.equal(distinct.size, 3, 'each run provisioned its own tab');

    // Neither sibling leaks into the other listing, and neither leaks into the
    // conversation main loop's.
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A, RUN_1)), tabIds(run1));
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A, RUN_2)), tabIds(run2));
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A)), tabIds(mainLoop));
  } finally {
    restore();
  }
});

test('each run keeps its own current tab', async () => {
  const { host, restore } = loadHost();
  try {
    const run1Tab = tabIds(await getTabs(host, OWNER_A, RUN_1))[0];
    const run2Tab = tabIds(await getTabs(host, OWNER_A, RUN_2))[0];
    assert.notEqual(run1Tab, run2Tab, 'the two runs really provisioned separate tabs');

    // Run 2 acting on its own tab must not move run 1's current tab.
    await navigate(host, OWNER_A, run2Tab, 'https://example.com/', RUN_2);

    assert.equal((await probeTabs(host, OWNER_A, RUN_1)).summary.currentTabId, run1Tab);
    assert.equal((await probeTabs(host, OWNER_A, RUN_2)).summary.currentTabId, run2Tab);
  } finally {
    restore();
  }
});

test('a run may act on a sibling run tab when the parent hands it the explicit tabId', async () => {
  const { host, restore } = loadHost();
  try {
    const run1Tab = tabIds(await getTabs(host, OWNER_A, RUN_1))[0];
    await getTabs(host, OWNER_A, RUN_2);

    const logs = [];
    const realLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    try {
      await navigate(host, OWNER_A, run1Tab, 'https://handed-over.example/', RUN_2);
    } finally {
      console.log = realLog;
    }

    assert.equal(contentsFor(run1Tab).getURL(), 'https://handed-over.example/');
    assert.equal(
      logs.some((line) => line.includes(RUN_2) && line.includes(RUN_1)),
      true,
      'the cross-run access is recorded so it is not invisible'
    );
    // Handing a tab over does NOT reassign it: it stays run 1's, and run 2's
    // own listing is unchanged.
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A, RUN_1)), [run1Tab]);
    assert.equal(
      tabIds(await probeTabs(host, OWNER_A, RUN_2)).includes(run1Tab),
      false,
      'an explicit hand-over does not make the tab visible to the borrower'
    );
  } finally {
    restore();
  }
});

test('a tab owned by another conversation is still refused, message unchanged', async () => {
  const { host, restore } = loadHost();
  try {
    const foreignTab = tabIds(await getTabs(host, OWNER_B, RUN_1))[0];
    await getTabs(host, OWNER_A, RUN_2);

    await assert.rejects(
      navigate(host, OWNER_A, foreignTab, 'https://example.com/', RUN_2),
      (error) => {
        assert.equal(
          error.message,
          `Browser tab ${foreignTab} belongs to another conversation's task. `
            + 'Call get_tabs to see your own tabs, or open a new tab with navigate.'
        );
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('browser_dispose_owner with a runKey reaps only that run', async () => {
  const { host, restore } = loadHost();
  try {
    const run1Tab = tabIds(await getTabs(host, OWNER_A, RUN_1))[0];
    const run2Tab = tabIds(await getTabs(host, OWNER_A, RUN_2))[0];
    const mainTab = tabIds(await getTabs(host, OWNER_A))[0];
    const otherConversationTab = tabIds(await getTabs(host, OWNER_B, RUN_1))[0];

    host.browserDispatch(null, 'browser_dispose_owner', {
      conversationId: OWNER_A,
      runKey: RUN_1,
    });

    assert.equal(contentsFor(run1Tab).isDestroyed(), true, 'the finished run released its tab');
    assert.equal(contentsFor(run2Tab).isDestroyed(), false, 'a sibling run is untouched');
    assert.equal(contentsFor(mainTab).isDestroyed(), false, 'the conversation main loop is untouched');
    assert.equal(contentsFor(otherConversationTab).isDestroyed(), false);

    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A, RUN_1)), []);
    assert.equal((await probeTabs(host, OWNER_A, RUN_1)).summary.currentTabId, null);
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A, RUN_2)), [run2Tab]);
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A)), [mainTab]);
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_B, RUN_1)), [otherConversationTab]);
  } finally {
    restore();
  }
});

test('browser_dispose_owner without a runKey still reaps every run of the conversation', async () => {
  const { host, restore } = loadHost();
  try {
    const run1Tab = tabIds(await getTabs(host, OWNER_A, RUN_1))[0];
    const run2Tab = tabIds(await getTabs(host, OWNER_A, RUN_2))[0];
    const mainTab = tabIds(await getTabs(host, OWNER_A))[0];
    const otherConversationTab = tabIds(await getTabs(host, OWNER_B, RUN_1))[0];

    host.browserDispatch(null, 'browser_dispose_owner', { conversationId: OWNER_A });

    assert.equal(contentsFor(run1Tab).isDestroyed(), true);
    assert.equal(contentsFor(run2Tab).isDestroyed(), true);
    assert.equal(contentsFor(mainTab).isDestroyed(), true);
    assert.equal(contentsFor(otherConversationTab).isDestroyed(), false);

    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A, RUN_1)), []);
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A, RUN_2)), []);
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A)), []);
  } finally {
    restore();
  }
});

test('a per-run dispose clears that run takeover record only', async () => {
  const { host, restore } = loadHost();
  try {
    const { clock, state } = fakeClock();
    host.__testing.setClock(clock);
    const run1Tab = tabIds(await getTabs(host, OWNER_A, RUN_1))[0];
    const run2Tab = tabIds(await getTabs(host, OWNER_A, RUN_2))[0];
    typeInto(run1Tab);
    typeInto(run2Tab);

    host.browserDispatch(null, 'browser_dispose_owner', {
      conversationId: OWNER_A,
      runKey: RUN_1,
    });

    // Run 1's record is gone with its views; run 2's is not, so run 2 still
    // backs off (virtual time never advanced, so its timestamp is still fresh).
    const freshRun1Tab = tabIds(await getTabs(host, OWNER_A, RUN_1))[0];
    await navigate(host, OWNER_A, freshRun1Tab, 'https://example.com/', RUN_1);
    assert.deepEqual(state.sleeps, [], 'no stale takeover record survived the per-run dispose');

    // Run 2's record survived, so run 2 still backs off — proving the sweep was
    // scoped to one run rather than to the whole conversation.
    await navigate(host, OWNER_A, run2Tab, 'https://example.com/', RUN_2);
    assert.ok(state.sleeps.length > 0, 'the sibling run still yields to the user');
  } finally {
    restore();
  }
});

test('a caller that sends no runId is the same owner as runKey "main"', async () => {
  // Byte-compat: the single-conversation, no-subagent world is the degenerate
  // one-dimensional case of the pair, not a second code path.
  const { host, restore } = loadHost();
  try {
    const mainTab = tabIds(await getTabs(host, OWNER_A))[0];
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A, 'main')), [mainTab]);
    assert.equal((await probeTabs(host, OWNER_A, 'main')).summary.currentTabId, mainTab);
  } finally {
    restore();
  }
});

test('legacy pane tabs stay visible to every run of every conversation', async () => {
  const { host, restore } = loadHost();
  try {
    host.browserDispatch(null, 'browser_create', {
      id: 'pane-tab-1',
      url: 'https://example.com/',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    const paneTab = tabIds(await probeTabs(host))[0];

    assert.deepEqual(tabIds(await probeTabs(host, OWNER_A, RUN_1)), [paneTab]);
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_B, RUN_2)), [paneTab]);

    // ...and a run may drive it without claiming it.
    await navigate(host, OWNER_A, paneTab, 'https://still-legacy.example/', RUN_1);
    assert.deepEqual(tabIds(await probeTabs(host, OWNER_B, RUN_2)), [paneTab]);
  } finally {
    restore();
  }
});

test('a run dispose never reaps the legacy pool, whatever the runKey', async () => {
  const { host, restore } = loadHost();
  try {
    host.browserDispatch(null, 'browser_create', {
      id: 'pane-tab-1',
      url: 'https://example.com/',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    const paneTab = tabIds(await probeTabs(host))[0];

    for (const runKey of [RUN_1, 'main', '', '   ', undefined, 42]) {
      assert.equal(
        host.browserDispatch(null, 'browser_dispose_owner', { conversationId: 'legacy', runKey }),
        null
      );
    }

    assert.equal(contentsFor(paneTab).isDestroyed(), false);
    assert.deepEqual(tabIds(await probeTabs(host)), [paneTab]);
  } finally {
    restore();
  }
});

test('a runId is never enough on its own to escape the legacy pool', async () => {
  // An `ownerId`-less caller is legacy no matter what run it claims to be:
  // otherwise a stray runId would mint a private pool nothing can dispose (the
  // dispose command refuses the legacy conversation by design).
  const { host, restore } = loadHost();
  try {
    const strayTab = tabIds(await getTabs(host, undefined, RUN_1))[0];
    assert.deepEqual(tabIds(await probeTabs(host)), [strayTab], 'it landed in the shared pool');
    assert.deepEqual(tabIds(await probeTabs(host, undefined, RUN_2)), [strayTab]);
  } finally {
    restore();
  }
});

/**
 * ## N7 — the user closing an agent's tab is a first-class reclaim signal
 *
 * Closing a tab used to be pure teardown: the view died, and the agent's very
 * next `get_tabs` silently provisioned a brand-new one and carried on. From the
 * user's side that reads as "the app ignored me" — the one gesture that means
 * "stop using the browser" was the one gesture with no effect on the run.
 *
 * A close now carries a REASON. `user_close` (the tab strip's ×, close
 * others/all — a real gesture) on a view an agent owns opens a RECLAIM WINDOW
 * for that owner:
 *  - `get_tabs` stops provisioning (as if `createIfEmpty:false`) and the summary
 *    carries a note telling the model to ask first;
 *  - a state-changing action or `navigate` with no tab left throws that same
 *    sentence — deliberately NOT the run-stopped message, which would tell the
 *    model something false about the run;
 *  - read-only work on tabs that are still open is untouched.
 *
 * The window is scoped to the owner PAIR (N6), so one subagent's reclaimed tab
 * does not mute its siblings, and it is lifted by the user's next message in
 * that conversation (`browser_clear_reclaim`) or by the conversation's dispose.
 * `lifecycle` closes — the C1 commit path's teardown, the C4 cancel cascade,
 * conversation delete — record nothing, and neither does closing a LEGACY tab:
 * the user closing their own pane tab is just closing a tab.
 */

const USER_RECLAIMED_MESSAGE =
  'The user closed your browser tab. Ask them before opening a new one.';

/** The view id main last invited the renderer to adopt. */
function lastAdoptedViewId(emitted) {
  const opens = emitted.filter((entry) => entry.event === 'browser://automation-open');
  assert.ok(opens.length > 0, 'no automation view was ever offered for adoption');
  return opens[opens.length - 1].payload.id;
}

function userCloses(host, viewId) {
  return host.browserDispatch(null, 'browser_close', { id: viewId, reason: 'user_close' });
}

function countOpens(emitted) {
  return emitted.filter((entry) => entry.event === 'browser://automation-open').length;
}

test('a user-closed agent tab stops get_tabs from opening another, and says why', async () => {
  const { host, emitted, restore } = loadHost();
  try {
    await getTabs(host, OWNER_A);
    const viewId = lastAdoptedViewId(emitted);
    const opensBefore = countOpens(emitted);

    userCloses(host, viewId);

    const after = await getTabs(host, OWNER_A);
    assert.deepEqual(tabIds(after), [], 'the run gets no replacement tab');
    assert.equal(after.summary.totalTabs, 0);
    assert.equal(after.summary.currentTabId, null);
    assert.equal(after.summary.note, USER_RECLAIMED_MESSAGE);
    assert.equal(countOpens(emitted), opensBefore, 'no new adoption was offered');
  } finally {
    restore();
  }
});

test('a state-changing action with no tab left reports the reclaim, not a missing tab', async () => {
  const { host, emitted, restore } = loadHost();
  try {
    await getTabs(host, OWNER_A);
    userCloses(host, lastAdoptedViewId(emitted));

    for (const action of ['navigate', 'click', 'fill', 'execute_js']) {
      await assert.rejects(
        host.performBrowserAutomation(action, { ownerId: OWNER_A, action: 'goto', url: 'https://example.com/' }),
        (error) => {
          assert.equal(error.message, USER_RECLAIMED_MESSAGE, `wrong message for ${action}`);
          return true;
        }
      );
    }
  } finally {
    restore();
  }
});

test('a run with no reclaim window still gets the ordinary tab-not-found error', async () => {
  const { host, restore } = loadHost();
  try {
    await assert.rejects(
      host.performBrowserAutomation('click', { ownerId: OWNER_A, tabId: 999999 }),
      /Browser tab not found: 999999/
    );
  } finally {
    restore();
  }
});

test('the reclaim window never blocks work on the tabs that are still open', async () => {
  // Two views for one owner (no renderer adoption ⇒ both fall through to the
  // headless branch), then the user closes exactly one of them.
  const { host, emitted, restore } = loadHost({ adopt: false });
  try {
    const [first, second] = await Promise.all([getTabs(host, OWNER_A), getTabs(host, OWNER_A)]);
    const bothTabs = [tabIds(first)[0], tabIds(second)[0]];
    assert.notEqual(bothTabs[0], bothTabs[1], 'the owner really has two views');

    // A headless fallback view keeps the id main offered for adoption, so the
    // two offers name the two views; which one backs which tab does not matter
    // — the survivor is simply the one still alive after the close.
    const opens = emitted
      .filter((entry) => entry.event === 'browser://automation-open')
      .map((entry) => entry.payload.id);
    assert.equal(opens.length, 2);
    host.browserDispatch(null, 'browser_close', { id: opens[0], reason: 'user_close' });
    const survivor = bothTabs.find((tab) => !contentsFor(tab).isDestroyed());
    assert.ok(survivor, 'exactly one view was closed');

    const stillListed = await probeTabs(host, OWNER_A);
    assert.deepEqual(tabIds(stillListed), [survivor]);
    assert.equal(stillListed.summary.note, USER_RECLAIMED_MESSAGE, 'the note is still on');

    // Read-only work on the surviving tab is exactly what a model should keep
    // doing, and a state-changing action on a tab that IS available is not the
    // case the window is about ("no tab left" is).
    await host.performBrowserAutomation('screenshot', { ownerId: OWNER_A, tabId: survivor });
    await navigate(host, OWNER_A, survivor, 'https://example.com/');
  } finally {
    restore();
  }
});

test('browser_clear_reclaim lifts the window for every run of that conversation', async () => {
  const { host, emitted, restore } = loadHost();
  try {
    await getTabs(host, OWNER_A, RUN_1);
    userCloses(host, lastAdoptedViewId(emitted));
    await getTabs(host, OWNER_A);
    userCloses(host, lastAdoptedViewId(emitted));
    await getTabs(host, OWNER_B);
    userCloses(host, lastAdoptedViewId(emitted));

    assert.equal(host.browserDispatch(null, 'browser_clear_reclaim', { conversationId: OWNER_A }), null);

    const run1 = await getTabs(host, OWNER_A, RUN_1);
    assert.equal(tabIds(run1).length, 1, 'the subagent run may open a tab again');
    assert.equal(run1.summary.note, undefined);
    const mainLoop = await getTabs(host, OWNER_A);
    assert.equal(tabIds(mainLoop).length, 1, 'so may the conversation main loop');
    assert.equal(mainLoop.summary.note, undefined);

    // Another conversation's window is its own and is untouched.
    const other = await getTabs(host, OWNER_B);
    assert.deepEqual(tabIds(other), []);
    assert.equal(other.summary.note, USER_RECLAIMED_MESSAGE);
  } finally {
    restore();
  }
});

test('a reclaim window is scoped to the run whose tab was closed', async () => {
  const { host, emitted, restore } = loadHost();
  try {
    await getTabs(host, OWNER_A, RUN_1);
    userCloses(host, lastAdoptedViewId(emitted));

    const reclaimed = await getTabs(host, OWNER_A, RUN_1);
    assert.deepEqual(tabIds(reclaimed), []);
    assert.equal(reclaimed.summary.note, USER_RECLAIMED_MESSAGE);

    const sibling = await getTabs(host, OWNER_A, RUN_2);
    assert.equal(tabIds(sibling).length, 1, 'a sibling run is not muted');
    assert.equal(sibling.summary.note, undefined);
    const mainLoop = await getTabs(host, OWNER_A);
    assert.equal(tabIds(mainLoop).length, 1, 'nor is the conversation main loop');
    assert.equal(mainLoop.summary.note, undefined);
  } finally {
    restore();
  }
});

test('closing a legacy pane tab, or a lifecycle close, records no reclaim', async () => {
  const { host, emitted, restore } = loadHost();
  try {
    // The user's own pane tab: closing it is just closing a tab.
    host.browserDispatch(null, 'browser_create', {
      id: 'pane-tab-1',
      url: 'https://example.com/',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    host.browserDispatch(null, 'browser_close', { id: 'pane-tab-1', reason: 'user_close' });
    const legacyAfter = await getTabs(host);
    assert.equal(tabIds(legacyAfter).length, 1, 'the shared pool still provisions');
    assert.equal(legacyAfter.summary.note, undefined);

    // A programmatic teardown of an OWNED view records nothing either — and an
    // unknown reason is treated as one (never as a user gesture).
    await getTabs(host, OWNER_A);
    host.browserDispatch(null, 'browser_close', { id: lastAdoptedViewId(emitted) });
    assert.equal((await getTabs(host, OWNER_A)).summary.note, undefined);

    await getTabs(host, OWNER_B);
    host.browserDispatch(null, 'browser_close', { id: lastAdoptedViewId(emitted), reason: 'nonsense' });
    assert.equal((await getTabs(host, OWNER_B)).summary.note, undefined);
  } finally {
    restore();
  }
});

test('disposing an owner clears its reclaim window with the rest of its state', async () => {
  const { host, emitted, restore } = loadHost();
  try {
    await getTabs(host, OWNER_A, RUN_1);
    userCloses(host, lastAdoptedViewId(emitted));

    host.browserDispatch(null, 'browser_dispose_owner', { conversationId: OWNER_A });

    const fresh = await getTabs(host, OWNER_A, RUN_1);
    assert.equal(tabIds(fresh).length, 1);
    assert.equal(fresh.summary.note, undefined);
  } finally {
    restore();
  }
});

test('a run dispose clears only that run reclaim window', async () => {
  const { host, emitted, restore } = loadHost();
  try {
    await getTabs(host, OWNER_A, RUN_1);
    userCloses(host, lastAdoptedViewId(emitted));
    await getTabs(host, OWNER_A, RUN_2);
    userCloses(host, lastAdoptedViewId(emitted));

    host.browserDispatch(null, 'browser_dispose_owner', { conversationId: OWNER_A, runKey: RUN_1 });

    assert.equal((await getTabs(host, OWNER_A, RUN_1)).summary.note, undefined);
    assert.equal((await getTabs(host, OWNER_A, RUN_2)).summary.note, USER_RECLAIMED_MESSAGE);
  } finally {
    restore();
  }
});

test('browser_clear_reclaim refuses the legacy conversation and blank input', async () => {
  const { host, restore } = loadHost();
  try {
    for (const conversationId of ['legacy', '', '   ', undefined, 42]) {
      assert.equal(host.browserDispatch(null, 'browser_clear_reclaim', { conversationId }), null);
    }
  } finally {
    restore();
  }
});
