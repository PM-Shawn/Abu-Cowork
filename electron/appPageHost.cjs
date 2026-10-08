'use strict';
/**
 * App pages — the `url:` navigation items of an app (docs/app-spec.md, "应用网页"),
 * shown in the main area as a `WebContentsView` painted over the renderer, the
 * way the built-in browser's views are.
 *
 * There is no channel between the page and Abu: the view has no preload, and
 * the renderer never hands this host a URL. `show` names an app and a nav
 * item; the host reads the app's own copied `app.json` under `~/.abu/apps/`
 * (for an app the user added) or the organization app configuration the
 * renderer registered with `setManagedApps`, validates it with the shared
 * validator and takes the URL from there — so a page is always one listed in
 * the app's own configuration, inside the origins it declares.
 *
 * Every app gets its own persistent session partition (its login state), kept
 * apart from the agent browser's partition; device-permission requests are
 * refused; navigation and pop-ups outside `allowedOrigins` open in the system
 * browser instead of the view.
 *
 * Electron and the filesystem are injected so the policy is unit-testable
 * (`appPageHost.test.cjs`); production wiring is in tauriHost.cjs.
 */
const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { APP_FILE_PATH, isAllowedAppPageOrigin, parseAppFile, resolveAppPageUrl } = require('./shared/appSpec.mjs');

const APP_PAGE_CHANNEL = 'abu:app-page';
const APP_PAGE_STATE_EVENT = 'app-page://state';
const ACTIONS = new Set(['show', 'setBounds', 'hide', 'reload', 'destroyForApp', 'setManagedApps']);
const MANAGED_APP_PREFIX = 'enterprise-app:';

function fail(message) {
  throw new Error(`App page: ${message}`);
}

function partitionFor(appId) {
  return `persist:abu-app-${crypto.createHash('sha256').update(appId).digest('hex').slice(0, 16)}`;
}

function toRect(bounds) {
  if (!bounds || typeof bounds !== 'object') fail('bounds required');
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(value => typeof value === 'number' && Number.isFinite(value))) fail('bounds must be finite numbers');
  return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(width, 1)), height: Math.round(Math.max(height, 1)) };
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function sameOrigins(left, right) {
  return left.length === right.length && left.every((origin, index) => origin === right[index]);
}

/** The id doubles as a directory name under `~/.abu/apps/`, so it may not carry a separator, a control character or only dots. */
function isSafeAppId(appId) {
  return typeof appId === 'string' && appId.length > 0 && !/[/\\\u0000-\u001f\u007f-\u009f]/.test(appId) && !/^\.+$/.test(appId) && appId.trim() === appId;
}

/**
 * The page URL and allowed origins for `(appId, navItemId)`: from the
 * organization configuration registered for `appId`, or from the added app's
 * own `app.json`. Throws when the app is unknown or the item is not a page.
 */
function resolvePage({ home, fs, appId, navItemId, managed }) {
  if (appId.startsWith(MANAGED_APP_PREFIX)) {
    const config = managed.get(appId);
    if (!config) fail(`app ${appId} is not an organization app of this session`);
    return { url: resolveAppPageUrl(config, navItemId), allowedOrigins: config.allowedOrigins ?? [] };
  }
  if (!isSafeAppId(appId)) fail(`app id ${JSON.stringify(appId)} cannot name a directory`);
  const appsRoot = path.join(home, '.abu', 'apps');
  let records;
  try { records = JSON.parse(fs.readFileSync(path.join(appsRoot, 'added.json'), 'utf8')); }
  catch (error) { fail(`added apps unreadable: ${error.message}`); }
  if (!Array.isArray(records)) fail('added apps unreadable');
  const record = records.find(entry => entry && typeof entry === 'object' && entry.appId === appId);
  if (!record || !record.origin || typeof record.origin.kind !== 'string') fail(`app ${appId} is not added`);
  const raw = JSON.parse(fs.readFileSync(path.join(appsRoot, appId, APP_FILE_PATH), 'utf8'));
  const file = parseAppFile(raw, { source: record.origin.kind === 'created' ? 'created' : 'package' });
  return { url: resolveAppPageUrl(file.config, navItemId), allowedOrigins: file.config.allowedOrigins ?? [] };
}

/**
 * The part of an organization app's configuration pages need: its nav items
 * and its origins, each origin held to the same rule an app file is.
 */
function managedPageConfig(entry) {
  if (!entry || typeof entry !== 'object') fail('organization app required');
  const { appId, nav, allowedOrigins } = entry;
  if (typeof appId !== 'string' || !appId.startsWith(MANAGED_APP_PREFIX)) fail('organization app id required');
  const origins = allowedOrigins === undefined ? [] : allowedOrigins;
  if (!Array.isArray(origins) || !origins.every(isAllowedAppPageOrigin)) fail(`app ${appId} has an invalid allowed origin`);
  if (nav !== undefined && (!nav || typeof nav !== 'object' || !Array.isArray(nav.items))) fail(`app ${appId} has an invalid nav`);
  return { appId, config: { nav, allowedOrigins: origins } };
}

/**
 * @param {object} options
 * @param {string} options.home
 * @param {() => import('electron').BrowserWindow | null} options.getMainWindow
 * @param {(event: string, payload: unknown) => void} options.emit
 * @param {(webPreferences: object) => import('electron').WebContentsView} options.createView
 * @param {(partition: string) => import('electron').Session} options.sessionFor
 * @param {(url: string) => void} options.openExternal
 */
function createAppPageHost({ home, getMainWindow, emit, createView, sessionFor, openExternal, fs = nodeFs }) {
  if (typeof home !== 'string' || !home) fail('home required');
  /** `["<appId>","<navItemId>"]` → { view, appId, navItemId, allowedOrigins, url } */
  const pages = new Map();
  /** Organization apps' page configuration, by app id, as last registered. */
  const managed = new Map();
  const preparedPartitions = new Set();
  let closeHooked = null;

  // JSON, so no app id or nav id can spell another pair's key.
  const keyOf = (appId, navItemId) => JSON.stringify([appId, navItemId]);
  const requireIds = request => {
    if (!request || typeof request !== 'object') fail('request required');
    const { appId, navItemId } = request;
    if (typeof appId !== 'string' || !appId) fail('appId required');
    if (typeof navItemId !== 'string' || !navItemId) fail('navItemId required');
    return { appId, navItemId };
  };
  const window = () => {
    const win = getMainWindow();
    if (!win) fail('no window');
    return win;
  };

  function sessionForApp(appId) {
    const partition = partitionFor(appId);
    const ses = sessionFor(partition);
    if (!preparedPartitions.has(partition)) {
      // Camera, microphone, geolocation, notifications, …: refused outright.
      // The same four handlers the agent browser's partition sets
      // (browserHost.cjs): `getDisplayMedia` and WebHID/WebUSB device access
      // take their own channels and never reach the first two.
      ses.setPermissionCheckHandler(() => false);
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
      if (typeof ses.setDisplayMediaRequestHandler === 'function') ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      preparedPartitions.add(partition);
    }
    return ses;
  }

  function leaveToSystemBrowser(url) {
    const origin = originOf(url);
    if (origin && /^https?:$/.test(new URL(url).protocol)) openExternal(url);
  }

  function attachPolicy(page) {
    const { view, appId, navItemId } = page;
    const contents = view.webContents;
    const allowed = url => {
      const origin = originOf(url);
      return origin !== null && page.allowedOrigins.includes(origin);
    };
    // `will-frame-navigate` covers the main frame AND every subframe;
    // `will-navigate` alone would leave an <iframe> free to load anything,
    // inside this app's own persistent partition.
    const guard = details => {
      const url = details && typeof details.url === 'string' ? details.url : '';
      if (allowed(url)) return;
      details.preventDefault();
      // Only a main-frame navigation is something the user asked for, so only
      // that one is worth handing to the system browser; a subframe that tries
      // to leave is refused and nothing else happens.
      if (details.isMainFrame !== false) leaveToSystemBrowser(url);
    };
    contents.on('will-frame-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(({ url }) => {
      leaveToSystemBrowser(url);
      return { action: 'deny' };
    });
    const state = (value, extra = {}) => emit(APP_PAGE_STATE_EVENT, { appId, navItemId, state: value, ...extra });
    contents.on('did-start-loading', () => state('loading'));
    contents.on('did-finish-load', () => state('ready'));
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation the guard above cancelled, or one superseded by the next.
      if (!isMainFrame || errorCode === -3) return;
      state('failed', { errorDescription: `${errorDescription} (${errorCode})` });
    });
  }

  function destroyPage(key) {
    const page = pages.get(key);
    if (!page) return;
    pages.delete(key);
    const win = getMainWindow();
    if (win) win.contentView.removeChildView(page.view);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  }

  function hideAll() {
    for (const page of pages.values()) page.view.setVisible(false);
  }

  function show(request) {
    const { appId, navItemId } = requireIds(request);
    for (const field of Object.keys(request)) {
      if (!['appId', 'navItemId', 'bounds'].includes(field)) fail(`unexpected field ${field}`);
    }
    const rect = toRect(request.bounds);
    const win = window();
    if (closeHooked !== win) {
      closeHooked = win;
      win.once('closed', () => { for (const key of [...pages.keys()]) destroyPage(key); });
    }
    hideAll();
    const key = keyOf(appId, navItemId);
    // Resolved on every show, never taken from the open view: an app added
    // again, or updated, keeps its id, and the page it may show — with the
    // origins it may navigate within — is the one in its configuration now,
    // not the one this view was created with.
    const resolved = resolvePage({ home, fs, appId, navItemId, managed });
    let page = pages.get(key);
    if (page && (page.url !== resolved.url || !sameOrigins(page.allowedOrigins, resolved.allowedOrigins))) {
      destroyPage(key);
      page = undefined;
    }
    if (!page) {
      const view = createView({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        session: sessionForApp(appId),
      });
      page = { view, appId, navItemId, allowedOrigins: resolved.allowedOrigins, url: resolved.url };
      attachPolicy(page);
      // Electron's proven order (browserHost.cjs): attach, size, then load.
      win.contentView.addChildView(view);
      view.setBounds(rect);
      pages.set(key, page);
      void view.webContents.loadURL(resolved.url);
    } else {
      page.view.setBounds(rect);
    }
    page.view.setVisible(true);
    return null;
  }

  function setBounds(request) {
    const { appId, navItemId } = requireIds(request);
    const page = pages.get(keyOf(appId, navItemId));
    if (!page) fail('page not shown');
    page.view.setBounds(toRect(request.bounds));
    return null;
  }

  function hide() {
    hideAll();
    return null;
  }

  function reload(request) {
    const { appId, navItemId } = requireIds(request);
    const page = pages.get(keyOf(appId, navItemId));
    if (!page) fail('page not shown');
    void page.view.webContents.loadURL(page.url);
    return null;
  }

  function destroyForApp(request) {
    if (!request || typeof request.appId !== 'string' || !request.appId) fail('appId required');
    for (const [key, page] of [...pages.entries()]) {
      if (page.appId === request.appId) destroyPage(key);
    }
    if (request.clearStorage === true) {
      const partition = partitionFor(request.appId);
      preparedPartitions.delete(partition);
      return sessionFor(partition).clearStorageData().then(() => null);
    }
    return null;
  }

  /** Replace the organization apps' page configuration; pages of apps no longer listed close. */
  function setManagedApps(request) {
    if (!request || !Array.isArray(request.apps)) fail('apps required');
    const next = new Map(request.apps.map(managedPageConfig).map(({ appId, config }) => [appId, config]));
    managed.clear();
    for (const [appId, config] of next) managed.set(appId, config);
    for (const [key, page] of [...pages.entries()]) {
      if (page.appId.startsWith(MANAGED_APP_PREFIX) && !managed.has(page.appId)) destroyPage(key);
    }
    return null;
  }

  function dispatch(action, request = {}) {
    if (!ACTIONS.has(action)) fail(`unsupported action ${action}`);
    switch (action) {
      case 'show': return show(request);
      case 'setBounds': return setBounds(request);
      case 'hide': return hide();
      case 'reload': return reload(request);
      case 'destroyForApp': return destroyForApp(request);
      case 'setManagedApps': return setManagedApps(request);
      default: return fail(`unsupported action ${action}`);
    }
  }

  return {
    dispatch,
    /** Test seam: the pages currently held, by key. */
    pages,
  };
}

module.exports = { APP_PAGE_CHANNEL, APP_PAGE_STATE_EVENT, createAppPageHost, partitionFor, resolvePage, toRect };
