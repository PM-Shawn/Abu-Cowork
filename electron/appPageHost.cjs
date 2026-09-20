'use strict';
/**
 * App pages — the `url:` navigation items of an installed app (developer spec
 * §8.4–8.5), shown in the main area as a `WebContentsView` painted over the
 * renderer, the way the built-in browser's views are.
 *
 * There is no channel between the page and Abu: the view has no preload, and
 * the renderer never hands this host a URL. `app_page_show` names a plugin
 * and a nav item; the host reads the install record and the package's own
 * manifest, validates the app config with the shared validator and takes the
 * URL from there, so a page can only ever be one the user approved at install.
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
const { parseAppConfig, resolveAppPageUrl } = require('./shared/pluginAppSpec.mjs');
const { validRecord } = require('./pluginRegistryHost.cjs');

const APP_PAGE_CHANNEL = 'abu:app-page';
const APP_PAGE_STATE_EVENT = 'app-page://state';
const MANIFEST_CANDIDATES = ['.abu-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
const ACTIONS = new Set(['show', 'setBounds', 'hide', 'reload', 'destroyForPlugin']);

function fail(message) {
  throw new Error(`App page: ${message}`);
}

function partitionFor(pluginKey) {
  return `persist:abu-app-${crypto.createHash('sha256').update(pluginKey).digest('hex').slice(0, 16)}`;
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

/**
 * The page URL and allowed origins for `(pluginKey, navItemId)`, from the
 * install record and the installed package's manifest. Throws when the plugin
 * is not installed, the manifest has no `app`, or the item is not a page.
 */
function resolvePage({ home, fs, pluginKey, navItemId }) {
  const root = path.join(home, '.abu', 'plugin-packages');
  let records;
  try { records = JSON.parse(fs.readFileSync(path.join(root, 'installed.json'), 'utf8')); }
  catch (error) { fail(`installed plugins unreadable: ${error.message}`); }
  if (!Array.isArray(records)) fail('installed plugins unreadable');
  const record = records.find(entry => validRecord(entry) && entry.key === pluginKey);
  if (!record) fail(`plugin ${pluginKey} is not installed`);
  const packageDir = path.join(root, record.marketplace, record.name, record.version);
  let manifest = null;
  for (const candidate of MANIFEST_CANDIDATES) {
    const file = path.join(packageDir, candidate);
    if (!fs.existsSync(file)) continue;
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    break;
  }
  if (!manifest || typeof manifest !== 'object') fail(`plugin ${pluginKey} has no manifest`);
  if (manifest.app === undefined) fail(`plugin ${pluginKey} is not an app`);
  const contributed = record.contributed;
  const inlineServers = manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)
    ? Object.keys(manifest.mcpServers)
    : [];
  const config = parseAppConfig(manifest.app, {
    teamIds: contributed.teams ?? [],
    agentNames: contributed.agents ?? [],
    skillNames: contributed.skills ?? [],
    // Same widening as `appRegistry.declaredConnectorNames`: a connector the
    // install skipped because the user already had that name is still one the
    // package declared, and `requiredConnectors` only drives a hint.
    mcpServerNames: [...new Set([...(contributed.mcpServers ?? []), ...inlineServers])],
  });
  return { url: resolveAppPageUrl(config, navItemId), allowedOrigins: config.allowedOrigins ?? [] };
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
  /** `["<pluginKey>","<navItemId>"]` → { view, pluginKey, navItemId, allowedOrigins, url } */
  const pages = new Map();
  const preparedPartitions = new Set();
  let closeHooked = null;

  // JSON, so no plugin key or nav id can spell another pair's key.
  const keyOf = (pluginKey, navItemId) => JSON.stringify([pluginKey, navItemId]);
  const requireIds = request => {
    if (!request || typeof request !== 'object') fail('request required');
    const { pluginKey, navItemId } = request;
    if (typeof pluginKey !== 'string' || !pluginKey) fail('pluginKey required');
    if (typeof navItemId !== 'string' || !navItemId) fail('navItemId required');
    return { pluginKey, navItemId };
  };
  const window = () => {
    const win = getMainWindow();
    if (!win) fail('no window');
    return win;
  };

  function sessionForPlugin(pluginKey) {
    const partition = partitionFor(pluginKey);
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
    const { view, pluginKey, navItemId } = page;
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
    const state = (value, extra = {}) => emit(APP_PAGE_STATE_EVENT, { pluginKey, navItemId, state: value, ...extra });
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
    const { pluginKey, navItemId } = requireIds(request);
    for (const field of Object.keys(request)) {
      if (!['pluginKey', 'navItemId', 'bounds'].includes(field)) fail(`unexpected field ${field}`);
    }
    const rect = toRect(request.bounds);
    const win = window();
    if (closeHooked !== win) {
      closeHooked = win;
      win.once('closed', () => { for (const key of [...pages.keys()]) destroyPage(key); });
    }
    hideAll();
    const key = keyOf(pluginKey, navItemId);
    // Resolved on every show, never taken from the open view: an update
    // installed in place keeps the same plugin key, and the page it may show —
    // with the origins it may navigate within — is the one in the version on
    // disk now, not the one this view was created with.
    const resolved = resolvePage({ home, fs, pluginKey, navItemId });
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
        session: sessionForPlugin(pluginKey),
      });
      page = { view, pluginKey, navItemId, allowedOrigins: resolved.allowedOrigins, url: resolved.url };
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
    const { pluginKey, navItemId } = requireIds(request);
    const page = pages.get(keyOf(pluginKey, navItemId));
    if (!page) fail('page not shown');
    page.view.setBounds(toRect(request.bounds));
    return null;
  }

  function hide() {
    hideAll();
    return null;
  }

  function reload(request) {
    const { pluginKey, navItemId } = requireIds(request);
    const page = pages.get(keyOf(pluginKey, navItemId));
    if (!page) fail('page not shown');
    void page.view.webContents.loadURL(page.url);
    return null;
  }

  function destroyForPlugin(request) {
    if (!request || typeof request.pluginKey !== 'string' || !request.pluginKey) fail('pluginKey required');
    for (const [key, page] of [...pages.entries()]) {
      if (page.pluginKey === request.pluginKey) destroyPage(key);
    }
    if (request.clearStorage === true) {
      const partition = partitionFor(request.pluginKey);
      preparedPartitions.delete(partition);
      return sessionFor(partition).clearStorageData().then(() => null);
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
      case 'destroyForPlugin': return destroyForPlugin(request);
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
