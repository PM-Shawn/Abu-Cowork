'use strict';

/** Native CDP frame identities and isolated per-frame execution. A page-authored
 * iframe src never supplies an approval origin. Only the requested tab is
 * probed, and opaque origins remain inaccessible. */

const assert = require('node:assert/strict');
const test = require('node:test');

const electronId = require.resolve('electron');
const tauriHostId = require.resolve('./tauriHost.cjs');
const browserHostId = require.resolve('./browserHost.cjs');

const OWNER = 'conversation-frames';
const PAGE = 'https://oa.example.com/apply';

let nextContentsId = 900;
const contentsRegistry = new Map();

/** The origin Electron would report for a url, or undefined when it has none. */
function originOfUrl(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return undefined;
  }
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
    const debugHandlers = [];
    let attached = false;
    this.debugger = {
      isAttached: () => attached,
      attach() { attached = true; },
      detach() { attached = false; for (const [event, handler] of debugHandlers) if (event === 'detach') handler(); },
      on(event, handler) { debugHandlers.push([event, handler]); return this; },
      sendCommand: async (method, params) => {
        if (method === 'Page.getFrameTree') return {frameTree: {
          frame: {id: 'main', loaderId: 'main-doc', url: this.url, securityOrigin: originOfUrl(this.url)},
          childFrames: this.realFrames.map((value, i) => {
            const frame = typeof value === 'string' ? {url:value, origin:originOfUrl(value)} : value;
            return {frame: {id: `child-${i}`, loaderId: 'child-doc', url:frame.url, securityOrigin:frame.origin}};
          }),
        }};
        if (method === 'Page.createIsolatedWorld') {
          for (const [event, handler] of debugHandlers) if (event === 'message') handler({}, 'Runtime.executionContextCreated', {context: {id:10, uniqueId:'unique-' + params.frameId, name:params.worldName, auxData:{frameId:params.frameId}}});
          return {executionContextId: 10};
        }
        if (method === 'Runtime.evaluate') {
          const call = /handleAction\(\s*"([a-z_]+)"/.exec(params.expression);
          if (call) this.domActions.push(call[1]);
          return {result: {value: {success:true}}};
        }
        return {};
      },
    };
    /** What the injected runtime answers `frames` with. */
    this.runtimeFrames = [];
    /** What the BROWSER's own frame tree says, which no page authors. */
    this.realFrames = [];
    /** Every action the runtime was asked to perform. */
    this.domActions = [];
  }

  get mainFrame() {
    const contents = this;
    return {
      get framesInSubtree() {
        // `origin` as Electron 43 reports it: the browser's own answer, and
        // the literal string 'null' for an opaque (sandboxed) frame. A row
        // given as a bare string is a frame that reports no origin at all,
        // which is what makes the url fallback observable.
        return [
          { url: contents.url, origin: originOfUrl(contents.url) },
          ...contents.realFrames.map((frame) => (typeof frame === 'string'
            ? { url: frame }
            : frame)),
        ];
      },
    };
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return this;
  }

  once(event, handler) { return this.on(event, handler); }
  removeListener(event, handler) {
    this.listeners.set(event, (this.listeners.get(event) || []).filter(value => value !== handler));
  }
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
    // A tab suspended inside a native dialog runs nothing: the isolated-world
    // call never settles either, same renderer, same blocked main thread.
    if (this.suspendPageCalls) return new Promise(() => {});
    if (/typeof globalThis/.test(code)) return true;
    const call = /handleAction\(\s*"([a-z_]+)"/.exec(code);
    if (!call) return undefined;
    const action = call[1];
    this.domActions.push(action);
    if (action === 'frames') return this.runtimeFrames;
    if (action === 'snapshot') {
      return { url: this.url, title: this.title, frameId: 'f0', elements: [], frames: this.runtimeFrames };
    }
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

function fakeSession() {
  return {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    setDevicePermissionHandler() {},
    setDisplayMediaRequestHandler() {},
    on() {},
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
      session: { fromPartition: () => fakeSession() },
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
  return {
    host,
    restore() {
      if (prevElectron) require.cache[electronId] = prevElectron;
      else delete require.cache[electronId];
      if (prevTauri) require.cache[tauriHostId] = prevTauri;
      else delete require.cache[tauriHostId];
      delete require.cache[browserHostId];
    },
  };
}

/** Provision one automation tab, on a real page, with the regions a case needs. */
async function openTab(host, { runtimeFrames = [], realFrames = [] } = {}) {
  const tabs = await host.performBrowserAutomation('get_tabs', { ownerId: OWNER });
  const tabId = tabs.windows[0].tabs[0].tabId;
  const contents = contentsRegistry.get(tabId);
  await host.performBrowserAutomation('navigate', { ownerId: OWNER, tabId, action: 'goto', url: PAGE });
  contents.runtimeFrames = runtimeFrames;
  contents.realFrames = realFrames;
  return { tabId, contents };
}

const REGION_SAME = {
  frameId: 'f1',
  parentFrameId: 'f0',
  origin: 'https://oa.example.com',
  url: 'https://oa.example.com/apply/inner',
  sameOriginAsTop: true,
  accessible: true,
};

/** A region the runtime cannot see into: the origin is a `src`-derived hint. */
function opaqueRegion(origin) {
  return {
    frameId: 'f2',
    parentFrameId: 'f0',
    origin,
    url: `${origin}/widget`,
    sameOriginAsTop: false,
    accessible: false,
    inaccessibleReason: 'cross-origin-unreachable',
  };
}

function tabRow(listing, tabId) {
  return listing.windows[0].tabs.find((tab) => tab.tabId === tabId);
}

test('get_tabs carries the regions of the tab the GATE names, so it has something to judge', async () => {
  const { host, restore } = loadHost();
  try {
    const main = { frameId: 'f0', origin: 'https://oa.example.com', url: PAGE, sameOriginAsTop: true, accessible: true };
    const { tabId } = await openTab(host, {
      runtimeFrames: [main, REGION_SAME],
      realFrames: [REGION_SAME.url],
    });

    const listing = await host.performBrowserAutomation('get_tabs', { ownerId: OWNER, framesForTabId: tabId });

    const frames = tabRow(listing, tabId).frames;
    assert.match(frames[1].frameId, /^f\d+$/);
    assert.deepEqual(frames, [main, {...REGION_SAME, frameId: frames[1].frameId}]);
  } finally {
    restore();
  }
});

/**
 * Round-2 F6. `batch` re-reads the tab before every step, and the frame probe
 * is one round trip INTO the page — so an ordinary 25-step batch that never
 * mentions a region was paying 25 of them for a list nobody asked for.
 */
test('a listing nobody asked frames for costs no round trip into the page', async () => {
  const { host, restore } = loadHost();
  try {
    const main = { frameId: 'f0', origin: 'https://oa.example.com', url: PAGE, sameOriginAsTop: true, accessible: true };
    const { tabId, contents } = await openTab(host, {
      runtimeFrames: [main, REGION_SAME],
      realFrames: [REGION_SAME.url],
    });
    contents.domActions.length = 0;

    const listing = await host.performBrowserAutomation('get_tabs', { ownerId: OWNER });

    assert.equal('frames' in tabRow(listing, tabId), false);
    assert.deepEqual(contents.domActions, []);
  } finally {
    restore();
  }
});

/**
 * Round-2 F6, the other half: even when the gate DOES ask, a page the browser
 * itself says has no child frame is not probed. `framesInSubtree` is main-
 * process state and free; the probe is not, and on such a page it could only
 * ever return the main frame, which the caller discards anyway.
 */
test('a page the browser says has no child frame is not probed even when asked', async () => {
  const { host, restore } = loadHost();
  try {
    const main = { frameId: 'f0', origin: 'https://oa.example.com', url: PAGE, sameOriginAsTop: true, accessible: true };
    const { tabId, contents } = await openTab(host, { runtimeFrames: [main], realFrames: [] });
    contents.domActions.length = 0;

    const listing = await host.performBrowserAutomation('get_tabs', { ownerId: OWNER, framesForTabId: tabId });

    assert.equal('frames' in tabRow(listing, tabId), false);
    assert.deepEqual(contents.domActions, []);
  } finally {
    restore();
  }
});

test('a page with no regions is listed exactly as it was before frames existed', async () => {
  const { host, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, {
      runtimeFrames: [{ frameId: 'f0', origin: 'https://oa.example.com', url: PAGE, sameOriginAsTop: true, accessible: true }],
    });

    const listing = await host.performBrowserAutomation('get_tabs', { ownerId: OWNER, framesForTabId: tabId });

    assert.equal('frames' in tabRow(listing, tabId), false);
  } finally {
    restore();
  }
});

test('an unreachable region keeps its origin only when the BROWSER agrees it is embedded', async () => {
  const { host, restore } = loadHost();
  try {
    const main = { frameId: 'f0', origin: 'https://oa.example.com', url: PAGE, sameOriginAsTop: true, accessible: true };
    const { tabId } = await openTab(host, {
      runtimeFrames: [main, opaqueRegion('https://vendor.example.net')],
      realFrames: ['https://vendor.example.net/widget'],
    });

    const listing = await host.performBrowserAutomation('get_tabs', { ownerId: OWNER, framesForTabId: tabId });

    assert.equal(tabRow(listing, tabId).frames[1].origin, 'https://vendor.example.net');
  } finally {
    restore();
  }
});

test('native origin replaces a forged src — the page cannot name the region\'s site', async () => {
  const { host, restore } = loadHost();
  try {
    // The page writes `src="https://bank.example.com/..."` while the frame is
    // really somewhere else (or nowhere). Reporting the attribute as the
    // region's origin would put a site the user trusts in front of them and
    // have the merged grant written against it.
    const main = { frameId: 'f0', origin: 'https://oa.example.com', url: PAGE, sameOriginAsTop: true, accessible: true };
    const { tabId } = await openTab(host, {
      runtimeFrames: [main, opaqueRegion('https://bank.example.com')],
      realFrames: ['https://tracker.example.org/pixel'],
    });

    const listing = await host.performBrowserAutomation('get_tabs', { ownerId: OWNER, framesForTabId: tabId });

    const region = tabRow(listing, tabId).frames[1];
    assert.match(region.frameId, /^f\d+$/);
    assert.equal(region.origin, 'https://tracker.example.org');
    assert.equal(region.accessible, true);
  } finally {
    restore();
  }
});

test('a REACHABLE region\'s origin is left alone: same-origin access already proved it', async () => {
  const { host, restore } = loadHost();
  try {
    const main = { frameId: 'f0', origin: 'https://oa.example.com', url: PAGE, sameOriginAsTop: true, accessible: true };
    const { tabId } = await openTab(host, {
      runtimeFrames: [main, REGION_SAME],
      // The browser knows the frame is there, but its address is `about:srcdoc`
      // — a region that INHERITS its parent's origin and so has no row the url
      // cross-check could ever match.
      realFrames: [{url: 'about:srcdoc', origin:'https://oa.example.com'}],
    });

    const listing = await host.performBrowserAutomation('get_tabs', { ownerId: OWNER, framesForTabId: tabId });

    assert.equal(tabRow(listing, tabId).frames[1].origin, 'https://oa.example.com');
  } finally {
    restore();
  }
});

/**
 * Round-2 F9. `WebFrameMain.origin` is the browser's own answer and is honest
 * about an opaque origin — a sandboxed frame reports the string 'null'.
 * Deriving one from the address instead would confirm a site for a document
 * that has none, and the page-authored `src` would then be believed.
 */
test('an opaque frame confirms nothing, even though its address looks like a site', async () => {
  const { host, restore } = loadHost();
  try {
    const main = { frameId: 'f0', origin: 'https://oa.example.com', url: PAGE, sameOriginAsTop: true, accessible: true };
    const { tabId } = await openTab(host, {
      runtimeFrames: [main, opaqueRegion('https://bank.example.com')],
      // The browser sees a frame whose ADDRESS is bank.example.com but whose
      // origin is opaque: it is sandboxed. It confirms nothing.
      realFrames: [{ url: 'https://bank.example.com/transfer', origin: 'null' }],
    });

    const listing = await host.performBrowserAutomation('get_tabs', { ownerId: OWNER, framesForTabId: tabId });

    assert.equal(tabRow(listing, tabId).frames[1].origin, null);
  } finally {
    restore();
  }
});

test('a snapshot\'s region list gets the same cross-check as the listing\'s', async () => {
  const { host, restore } = loadHost();
  try {
    const main = { frameId: 'f0', origin: 'https://oa.example.com', url: PAGE, sameOriginAsTop: true, accessible: true };
    const { tabId } = await openTab(host, {
      runtimeFrames: [main, opaqueRegion('https://bank.example.com')],
      realFrames: [],
    });

    const shot = await host.performBrowserAutomation('snapshot', { ownerId: OWNER, tabId });

    assert.equal(shot.frames, undefined, 'a runtime list cannot invent a native region');
  } finally {
    restore();
  }
});

test('a listing still answers for a tab frozen by a dialog, instead of waiting on it', async () => {
  const { host, restore } = loadHost();
  try {
    const main = { frameId: 'f0', origin: 'https://oa.example.com', url: PAGE, sameOriginAsTop: true, accessible: true };
    const { tabId, contents } = await openTab(host, {
      runtimeFrames: [main, REGION_SAME],
      realFrames: [REGION_SAME.url],
    });
    // The renderer is suspended — nothing injected into it will ever settle.
    // `get_tabs` is precisely how a caller LEARNS the tab is frozen, so it has
    // to come back regardless, with no frame list rather than no answer.
    contents.suspendPageCalls = true;

    const listing = await Promise.race([
      host.performBrowserAutomation('get_tabs', { ownerId: OWNER, framesForTabId: tabId }),
      new Promise((resolve) => setTimeout(() => resolve('TIMED OUT'), 3000)),
    ]);

    assert.notEqual(listing, 'TIMED OUT');
    assert.equal(tabRow(listing, tabId).frames.length, 2, 'native frame metadata does not need page script execution');
  } finally {
    restore();
  }
});

test('a frame-targeted action reaches the runtime with the region on it', async () => {
  const { host, restore } = loadHost();
  try {
    const main = { frameId: 'f0', origin: 'https://oa.example.com', url: PAGE, sameOriginAsTop: true, accessible: true };
    const { tabId, contents } = await openTab(host, { runtimeFrames: [main, REGION_SAME], realFrames: [REGION_SAME.url] });
    const listing = await host.performBrowserAutomation('get_tabs', {ownerId:OWNER, framesForTabId:tabId});
    const frameId = tabRow(listing, tabId).frames[1].frameId;

    await host.performBrowserAutomation('fill', {
      ownerId: OWNER, tabId, frameId, expectedOrigin: REGION_SAME.origin, locator: { css: '#name' }, value: '张三',
    });

    // The runtime resolves the document itself — this channel has one copy of
    // it, in the main frame, walking into same-origin children.
    assert.ok(contents.domActions.includes('fill'));
  } finally {
    restore();
  }
});

test('a cancelled frame permission probe never dispatches after runtime initialization', async () => {
  const { host, restore } = loadHost();
  try {
    const { tabId } = await openTab(host, { runtimeFrames: [REGION_SAME], realFrames: [REGION_SAME.url] });
    const contents = contentsRegistry.get(tabId);
    const controller = new AbortController();
    const send = contents.debugger.sendCommand;
    contents.debugger.sendCommand = async (method, params) => {
      const result = await send(method, params);
      if (method === 'Page.getFrameTree') controller.abort();
      return result;
    };
    await assert.rejects(host.performBrowserAutomation('get_tabs', {
      ownerId: OWNER, framesForTabId: tabId, createIfEmpty: false,
    }, { signal: controller.signal }), /cancelled|stopped/);
    assert.equal(contents.domActions.includes('frames'), false);
  } finally { restore(); }
});
