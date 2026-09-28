'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAppPageHost, partitionFor, resolvePage, toRect } = require('./appPageHost.cjs');

const APP_ID = 'shop-ops@market';
const ORG_APP_ID = 'enterprise-app:7f2c';

function appFile(home) {
  return path.join(home, '.abu', 'apps', APP_ID, '.abu-app', 'app.json');
}

function seedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-app-page-'));
  const apps = path.join(home, '.abu', 'apps');
  fs.mkdirSync(path.dirname(appFile(home)), { recursive: true });
  fs.writeFileSync(path.join(apps, 'added.json'), JSON.stringify([{
    appId: APP_ID, name: 'shop-ops', version: '1.0.0', origin: { kind: 'market', market: 'market' }, addedAt: '2026-09-28T00:00:00.000Z',
  }]));
  fs.writeFileSync(appFile(home), JSON.stringify({
    name: 'shop-ops', version: '1.0.0', minAbuVersion: '0.51.0',
    interface: { displayName: '店铺运营', shortDescription: '看店' },
    allowedOrigins: ['https://shop.example.com'],
    home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{ id: 's', title: 'S', run: { team: 'builtin-team:recruiting' }, templates: [
      { id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' },
    ] }] }] } },
    nav: { items: [
      { id: 'chat', target: 'builtin:chat' },
      { id: 'portal', title: 'Portal', target: 'url:https://shop.example.com/portal?tab=orders' },
    ] },
  }));
  return home;
}

const orgApp = {
  appId: ORG_APP_ID,
  allowedOrigins: ['https://contracts.example.com', 'https://sso.example.com'],
  nav: { items: [{ id: 'chat', target: 'builtin:chat' }, { id: 'system', title: '合同系统', target: 'url:https://contracts.example.com/home' }] },
};

/** A WebContentsView stand-in: records bounds/visibility and lets a test fire navigation events. */
function fakeView() {
  const webContents = new EventEmitter();
  webContents.loaded = [];
  webContents.destroyed = false;
  webContents.isDestroyed = () => webContents.destroyed;
  webContents.close = () => { webContents.destroyed = true; };
  webContents.loadURL = async url => { webContents.loaded.push(url); };
  webContents.setWindowOpenHandler = handler => { webContents.windowOpen = handler; };
  return { webContents, bounds: null, visible: true, setBounds(rect) { this.bounds = rect; }, setVisible(value) { this.visible = value; } };
}

function harness(home) {
  const events = [];
  const opened = [];
  const sessions = new Map();
  const views = [];
  const children = new Set();
  const win = Object.assign(new EventEmitter(), {
    contentView: { addChildView: view => children.add(view), removeChildView: view => children.delete(view) },
  });
  const host = createAppPageHost({
    home,
    getMainWindow: () => win,
    emit: (event, payload) => events.push({ event, payload }),
    createView: prefs => { const view = fakeView(); view.prefs = prefs; views.push(view); return view; },
    sessionFor: partition => {
      if (!sessions.has(partition)) sessions.set(partition, { partition, checks: 0, requests: 0, devices: 0, display: 0, cleared: 0,
        setPermissionCheckHandler() { this.checks += 1; }, setPermissionRequestHandler() { this.requests += 1; },
        setDevicePermissionHandler() { this.devices += 1; }, setDisplayMediaRequestHandler() { this.display += 1; },
        clearStorageData: async function () { this.cleared += 1; } });
      return sessions.get(partition);
    },
    openExternal: url => opened.push(url),
  });
  return { host, events, opened, sessions, views, children, win };
}

const bounds = { x: 0, y: 0, width: 10, height: 10 };

test('resolves a page from the added app\'s own copied file, never from the renderer', () => {
  const home = seedHome();
  try {
    const page = resolvePage({ home, fs, appId: APP_ID, navItemId: 'portal', managed: new Map() });
    assert.equal(page.url, 'https://shop.example.com/portal?tab=orders');
    assert.deepEqual(page.allowedOrigins, ['https://shop.example.com']);
    assert.throws(() => resolvePage({ home, fs, appId: APP_ID, navItemId: 'chat', managed: new Map() }), /not a url: target/);
    assert.throws(() => resolvePage({ home, fs, appId: 'ghost@market', navItemId: 'portal', managed: new Map() }), /is not added/);
    assert.throws(() => resolvePage({ home, fs, appId: '../escape', navItemId: 'portal', managed: new Map() }), /cannot name a directory/);
    const { host } = harness(home);
    assert.throws(() => host.dispatch('show', { appId: APP_ID, navItemId: 'portal', bounds, url: 'https://evil.example.com' }), /unexpected field url/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('shows a sandboxed view in the app\'s own partition, sized to the given bounds, and hides other pages', () => {
  const home = seedHome();
  try {
    const { host, views, sessions, children } = harness(home);
    host.dispatch('show', { appId: APP_ID, navItemId: 'portal', bounds: { x: 1.4, y: 2.6, width: 300.2, height: 0 } });
    assert.equal(views.length, 1);
    const [view] = views;
    assert.deepEqual(view.prefs, { sandbox: true, contextIsolation: true, nodeIntegration: false, session: sessions.get(partitionFor(APP_ID)) });
    // All four permission channels are closed, the way the agent browser's
    // partition closes them: `getDisplayMedia` and device access do not pass
    // through the first two handlers.
    assert.deepEqual([view.prefs.session.checks, view.prefs.session.requests, view.prefs.session.devices, view.prefs.session.display], [1, 1, 1, 1]);
    assert.match(partitionFor(APP_ID), /^persist:abu-app-[0-9a-f]{16}$/);
    assert.deepEqual(view.bounds, { x: 1, y: 3, width: 300, height: 1 });
    assert.ok(children.has(view));
    assert.deepEqual(view.webContents.loaded, ['https://shop.example.com/portal?tab=orders']);
    assert.equal(view.visible, true);

    host.dispatch('hide');
    assert.equal(view.visible, false);
    host.dispatch('show', { appId: APP_ID, navItemId: 'portal', bounds: { x: 0, y: 0, width: 50, height: 50 } });
    assert.equal(views.length, 1, 'the same page is reused, not reloaded');
    assert.deepEqual(view.webContents.loaded.length, 1);
    assert.equal(view.visible, true);
    host.dispatch('setBounds', { appId: APP_ID, navItemId: 'portal', bounds: { x: 5, y: 5, width: 20, height: 20 } });
    assert.deepEqual(view.bounds, { x: 5, y: 5, width: 20, height: 20 });
    assert.throws(() => toRect({ x: 'a', y: 0, width: 1, height: 1 }), /finite numbers/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('keeps the page inside allowedOrigins: outside navigations and pop-ups go to the system browser', () => {
  const home = seedHome();
  try {
    const { host, views, opened, events } = harness(home);
    host.dispatch('show', { appId: APP_ID, navItemId: 'portal', bounds });
    const { webContents } = views[0];
    const navigate = (url, isMainFrame = true) => {
      const details = { url, isMainFrame, prevented: false, preventDefault() { this.prevented = true; } };
      webContents.emit('will-frame-navigate', details);
      return details.prevented;
    };
    assert.equal(navigate('https://shop.example.com/orders/1'), false);
    assert.equal(navigate('https://shop.example.com:443/x'), false);
    assert.equal(navigate('https://evil.example.com/'), true);
    assert.equal(navigate('http://shop.example.com/'), true, 'a different scheme is a different origin');
    assert.equal(navigate('javascript:alert(1)'), true);
    // An <iframe> is held to the same origins, and a refused one is not handed
    // to the system browser — nobody asked for that page.
    assert.equal(navigate('https://tracker.example.net/pixel', false), true);
    assert.deepEqual(opened, ['https://evil.example.com/', 'http://shop.example.com/']);
    const redirect = { url: 'https://evil.example.com/next', isMainFrame: true, prevented: false, preventDefault() { this.prevented = true; } };
    webContents.emit('will-redirect', redirect);
    assert.equal(redirect.prevented, true);
    assert.deepEqual(webContents.windowOpen({ url: 'https://shop.example.com/help' }), { action: 'deny' });
    assert.deepEqual(opened.at(-1), 'https://shop.example.com/help');

    webContents.emit('did-start-loading');
    webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://evil.example.com/', true);
    webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://shop.example.com/portal', true);
    webContents.emit('did-finish-load');
    assert.deepEqual(events.map(entry => entry.payload.state), ['loading', 'failed', 'ready']);
    assert.equal(events[1].payload.errorDescription, 'ERR_NAME_NOT_RESOLVED (-105)');
    assert.equal(events[0].payload.appId, APP_ID);
    assert.equal(events[0].event, 'app-page://state');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('an app added again replaces the open page instead of keeping the old address and origins', () => {
  const home = seedHome();
  try {
    const { host, views, opened } = harness(home);
    host.dispatch('show', { appId: APP_ID, navItemId: 'portal', bounds });
    const first = views[0];

    const raw = JSON.parse(fs.readFileSync(appFile(home), 'utf8'));
    raw.allowedOrigins = ['https://portal.example.com'];
    raw.nav.items[1].target = 'url:https://portal.example.com/portal';
    fs.writeFileSync(appFile(home), JSON.stringify(raw));

    host.dispatch('show', { appId: APP_ID, navItemId: 'portal', bounds });
    assert.equal(views.length, 2, 'the view created against the replaced app is dropped');
    assert.equal(first.webContents.destroyed, true);
    assert.deepEqual(views[1].webContents.loaded, ['https://portal.example.com/portal']);

    const details = { url: 'https://shop.example.com/orders/1', isMainFrame: true, prevented: false, preventDefault() { this.prevented = true; } };
    views[1].webContents.emit('will-frame-navigate', details);
    assert.equal(details.prevented, true, 'the origin the previous version allowed is no longer allowed');
    assert.deepEqual(opened, ['https://shop.example.com/orders/1']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('shows an organization app\'s page from the configuration registered for it, login page included', () => {
  const home = seedHome();
  try {
    const { host, views } = harness(home);
    assert.throws(() => host.dispatch('show', { appId: ORG_APP_ID, navItemId: 'system', bounds }), /not an organization app of this session/);
    host.dispatch('setManagedApps', { apps: [orgApp] });
    host.dispatch('show', { appId: ORG_APP_ID, navItemId: 'system', bounds });
    assert.deepEqual(views[0].webContents.loaded, ['https://contracts.example.com/home']);
    // The company login page it is redirected to stays inside the view.
    const details = { url: 'https://sso.example.com/login', isMainFrame: true, prevented: false, preventDefault() { this.prevented = true; } };
    views[0].webContents.emit('will-frame-navigate', details);
    assert.equal(details.prevented, false);

    assert.throws(() => host.dispatch('setManagedApps', { apps: [{ ...orgApp, allowedOrigins: ['https://*.example.com'] }] }), /invalid allowed origin/);
    assert.throws(() => host.dispatch('setManagedApps', { apps: [{ ...orgApp, appId: 'shop@market' }] }), /organization app id required/);
    // An organization app that is no longer registered closes.
    host.dispatch('setManagedApps', { apps: [] });
    assert.equal(views[0].webContents.destroyed, true);
    assert.equal(host.pages.size, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('destroys an app\'s pages, clears its storage on request, and drops everything when the window closes', async () => {
  const home = seedHome();
  try {
    const { host, views, sessions, children, win } = harness(home);
    host.dispatch('show', { appId: APP_ID, navItemId: 'portal', bounds });
    await host.dispatch('destroyForApp', { appId: APP_ID, clearStorage: true });
    assert.equal(host.pages.size, 0);
    assert.equal(children.size, 0);
    assert.equal(views[0].webContents.destroyed, true);
    assert.equal(sessions.get(partitionFor(APP_ID)).cleared, 1);
    assert.throws(() => host.dispatch('reload', { appId: APP_ID, navItemId: 'portal' }), /page not shown/);

    host.dispatch('show', { appId: APP_ID, navItemId: 'portal', bounds });
    assert.equal(host.pages.size, 1);
    win.emit('closed');
    assert.equal(host.pages.size, 0);
    assert.throws(() => host.dispatch('nope'), /unsupported action/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
