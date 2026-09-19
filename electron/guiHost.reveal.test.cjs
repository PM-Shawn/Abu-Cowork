'use strict';

/**
 * guiHost.cjs reveals its floating windows (pet / overlay / stop-button)
 * through the window-show policy that main.cjs configures at boot
 * (electron/windowShowPolicy.cjs). Under the quiet E2E policy
 * (ABU_E2E_QUIET_WINDOW=1) every reveal must be `showInactive()` so an E2E
 * launch that opens the pet or the screen border never activates the app;
 * under the normal policy it must stay `show()` — the pre-existing user-facing
 * behaviour, which the first-show recorder (tests/e2e/mainProcessRecorderCore.cjs)
 * wraps on both methods.
 *
 * guiHost.cjs destructures from `electron` at load time, so the `electron`
 * cache slot is pre-filled with a fake BEFORE it is required — same technique
 * as windowPlacement.test.cjs / browserHost.ownership.test.cjs.
 */

const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');

/** Every window the fake `BrowserWindow` constructor created, in order. */
const created = [];

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this.reveals = [];
    this.listeners = new Map();
    this.destroyed = false;
    this.webContents = { id: created.length + 1, isDestroyed: () => false, on() {} };
    created.push(this);
  }
  isDestroyed() { return this.destroyed; }
  show() { this.reveals.push('show'); }
  showInactive() { this.reveals.push('showInactive'); }
  once(event, fn) { return this.on(event, fn); }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
    return this;
  }
  /** Fire an event the way Electron would (listeners registered via `once` are dropped after one call). */
  emit(event) {
    const fns = this.listeners.get(event) || [];
    this.listeners.set(event, []);
    for (const fn of fns) fn();
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents(ignore) { this.clickThrough = ignore; }
  loadFile() { return Promise.resolve(); }
  hide() {}
  destroy() { this.destroyed = true; }
  getBounds() { return this.bounds ?? { x: 0, y: 0, width: 80, height: 80 }; }
  setBounds(bounds) { this.bounds = bounds; }
  getPosition() { return [0, 0]; }
  static getAllWindows() { return created.filter((w) => !w.destroyed); }
  static fromWebContents() { return null; }
}

const DISPLAY = {
  id: 1,
  scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 33, width: 1512, height: 949 },
};

const electronId = require.resolve('electron');
require.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  exports: {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getPrimaryDisplay: () => DISPLAY,
      getAllDisplays: () => [DISPLAY],
      getDisplayNearestPoint: () => DISPLAY,
      getDisplayMatching: () => DISPLAY,
    },
    app: { isPackaged: false },
    Tray: class {},
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    ipcMain: {},
    nativeTheme: {},
    dialog: {},
  },
};

const { configureWindowShowPolicy, QUIET_WINDOW_ENV } = require('./windowShowPolicy.cjs');
const { guiDispatch, teardownGuiHost, __test } = require('./guiHost.cjs');

const QUIET = { env: { [QUIET_WINDOW_ENV]: '1' }, allowE2E: true, platform: 'darwin' };
const NORMAL = { env: {}, allowE2E: true, platform: 'darwin' };

/** Wait for the ready-to-show timeout fallback in showWhenReady() to fire. */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  teardownGuiHost();
  created.length = 0;
  configureWindowShowPolicy(NORMAL);
});

test('showWhenReady reveals with show() under the normal policy and showInactive() under the quiet one', () => {
  configureWindowShowPolicy(NORMAL);
  const normal = new FakeBrowserWindow({});
  __test.showWhenReady(normal, 50);
  assert.deepEqual(normal.reveals, [], 'nothing is revealed before ready-to-show');
  normal.emit('ready-to-show');
  assert.deepEqual(normal.reveals, ['show']);

  configureWindowShowPolicy(QUIET);
  const quiet = new FakeBrowserWindow({});
  __test.showWhenReady(quiet, 50);
  quiet.emit('ready-to-show');
  assert.deepEqual(quiet.reveals, ['showInactive']);
});

test('showWhenReady honours the policy on its timeout fallback too, and reveals only once', async () => {
  configureWindowShowPolicy(QUIET);
  const win = new FakeBrowserWindow({});
  __test.showWhenReady(win, 5);
  await settle(30);
  assert.deepEqual(win.reveals, ['showInactive'], 'timeout fallback used the quiet reveal');
  win.emit('ready-to-show');
  assert.deepEqual(win.reveals, ['showInactive'], 'a late ready-to-show does not reveal a second time');
});

test('pet_show creates the pet hidden and reveals it inactive under the quiet policy, on first show and re-show', () => {
  configureWindowShowPolicy(QUIET);
  assert.equal(guiDispatch(null, 'pet_show', {}), null);
  assert.equal(created.length, 1, 'one pet window was created');
  const pet = created[0];
  assert.equal(pet.options.show, false, 'the pet is constructed hidden so the reveal goes through the policy');
  pet.emit('ready-to-show');
  assert.deepEqual(pet.reveals, ['showInactive']);

  // Re-show of the existing pet window (pet_hide keeps the window alive).
  assert.equal(guiDispatch(null, 'pet_hide', {}), null);
  assert.equal(guiDispatch(null, 'pet_show', {}), null);
  assert.equal(created.length, 1, 're-show reuses the existing window');
  assert.deepEqual(pet.reveals, ['showInactive', 'showInactive']);
});

test('pet_show keeps the user-facing show() under the normal policy', () => {
  configureWindowShowPolicy(NORMAL);
  guiDispatch(null, 'pet_show', {});
  const pet = created[0];
  pet.emit('ready-to-show');
  guiDispatch(null, 'pet_hide', {});
  guiDispatch(null, 'pet_show', {});
  assert.deepEqual(pet.reveals, ['show', 'show']);
});

test('show_screen_border reveals the overlay and control strip inactive under the quiet policy, on first show and re-show', () => {
  configureWindowShowPolicy(QUIET);
  assert.equal(guiDispatch(null, 'show_screen_border', { stopLabel: '停止' }), null);
  assert.equal(created.length, 2, 'overlay + control-strip windows were created');
  // Both windows decline focus — a Stop click must not pull the foreground
  // away from the app Abu is driving — so what tells them apart is the mouse:
  // the overlay is click-through, the strip is what receives the click.
  const [overlay, strip] = created;
  assert.equal(overlay.clickThrough, true, 'first window is the click-through overlay');
  assert.equal(strip.clickThrough, undefined, 'second window is the clickable control strip');
  for (const win of created) {
    assert.equal(win.options.show, false);
    win.emit('ready-to-show');
    assert.deepEqual(win.reveals, ['showInactive']);
  }

  // Re-show on the already-created windows.
  assert.equal(guiDispatch(null, 'show_screen_border', { stopLabel: '停止' }), null);
  assert.equal(created.length, 2, 're-show reuses the existing windows');
  for (const win of created) assert.deepEqual(win.reveals, ['showInactive', 'showInactive']);
});

test('show_screen_border keeps the user-facing show() under the normal policy', () => {
  configureWindowShowPolicy(NORMAL);
  guiDispatch(null, 'show_screen_border', { stopLabel: 'Stop' });
  for (const win of created) win.emit('ready-to-show');
  guiDispatch(null, 'show_screen_border', { stopLabel: 'Stop' });
  assert.equal(created.length, 2);
  for (const win of created) assert.deepEqual(win.reveals, ['show', 'show']);
});
