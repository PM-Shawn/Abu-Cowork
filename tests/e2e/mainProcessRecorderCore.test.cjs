'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { installWindowShowRecorder, installEventListenRecorder } = require('./mainProcessRecorderCore.cjs');

/**
 * A BrowserWindow stand-in with the macOS reveal contract: `show()` /
 * `showInactive()` order the window on screen synchronously (isVisible() flips
 * true), while the 'show' event is emitted separately — Electron's
 * NativeWindowMac emits it from the NSWindow occlusion-state delegate, on a
 * later run-loop pass, and only once the window server reports the window
 * non-occluded (shell/browser/ui/cocoa/electron_ns_window_delegate.mm).
 */
function fakeWindow(id, { visible = false, bounds = { x: 0, y: 0, width: 80, height: 80 }, url = '' } = {}) {
  const win = new EventEmitter();
  win.id = id;
  win.webContents = { id: id * 10, getURL: () => url };
  win._visible = visible;
  win._bounds = { ...bounds };
  win._destroyed = false;
  win.isVisible = () => win._visible;
  win.isDestroyed = () => win._destroyed;
  win.getBounds = () => ({ ...win._bounds });
  win.setBounds = (b) => { win._bounds = { ...win._bounds, ...b }; };
  win.show = () => { win._visible = true; };
  win.showInactive = () => { win._visible = true; };
  return win;
}

function fakeApp() {
  return new EventEmitter();
}

test('a window revealed with show() is recorded at the moment of the call, before any show event', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(7, { bounds: { x: 240, y: 205, width: 80, height: 80 }, url: 'file:///pet.html' });
  app.emit('browser-window-created', {}, win);

  assert.deepEqual(records, [{ id: 7, shownBounds: null, shownUrl: null, shownVia: null }]);

  win.show();
  // No 'show' event has been emitted yet — the record must already be complete.
  assert.deepEqual(records[0], {
    id: 7,
    shownBounds: { x: 240, y: 205, width: 80, height: 80 },
    shownUrl: 'file:///pet.html',
    shownVia: 'show',
  });
  assert.equal(win.isVisible(), true, 'the wrapped show() still reveals the window');
});

test('showInactive() (the ABU_E2E_QUIET_WINDOW reveal) is recorded the same way', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(3, { bounds: { x: 10, y: 20, width: 800, height: 600 } });
  app.emit('browser-window-created', {}, win);

  win.showInactive();
  assert.deepEqual(records[0].shownBounds, { x: 10, y: 20, width: 800, height: 600 });
  assert.equal(records[0].shownVia, 'showInactive');
  assert.equal(win.isVisible(), true);
});

test('a window constructed already visible (show: true) is recorded at creation', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(1, { visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } });
  app.emit('browser-window-created', {}, win);

  assert.deepEqual(records[0].shownBounds, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(records[0].shownVia, 'constructor');
});

test('a reveal path the recorder does not wrap still lands via the show event fallback', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(5, { bounds: { x: 9, y: 9, width: 1, height: 1 }, url: 'file:///x.html' });
  app.emit('browser-window-created', {}, win);

  // e.g. restore() on a minimized-at-creation window: no show() call, only the event.
  win._visible = true;
  win.emit('show');
  assert.deepEqual(records[0].shownBounds, { x: 9, y: 9, width: 1, height: 1 });
  assert.equal(records[0].shownUrl, 'file:///x.html');
  assert.equal(records[0].shownVia, 'show-event');
});

test('only the FIRST reveal is kept: later show() calls and show events do not overwrite it', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(2, { bounds: { x: 240, y: 205, width: 80, height: 80 } });
  app.emit('browser-window-created', {}, win);

  win.show();
  win.setBounds({ x: 1290, y: 776 }); // a renderer-driven jump after first paint
  win.emit('show'); // the occlusion notification for the first reveal arrives late
  win.show(); // pet_show on an existing window re-shows it
  assert.deepEqual(records[0].shownBounds, { x: 240, y: 205, width: 80, height: 80 });
  assert.equal(records[0].shownVia, 'show');
});

test('a destroyed window never reports bounds from the show event fallback', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(4);
  app.emit('browser-window-created', {}, win);
  win._destroyed = true;
  win.emit('show');
  assert.equal(records[0].shownBounds, null);
});

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    invoke(channel, sender, ...args) {
      return handlers.get(channel)({ sender }, ...args);
    },
  };
}

test('the listen recorder logs plugin:event|listen per renderer and leaves the handler result intact', async () => {
  const ipcMain = fakeIpcMain();
  const listens = installEventListenRecorder(ipcMain);
  ipcMain.handle('tauri:invoke', async (_e, payload) => `handled:${payload.cmd}`);
  ipcMain.handle('other-channel', async () => 'other');

  const pet = { id: 42 };
  const main = { id: 1 };
  assert.equal(
    await ipcMain.invoke('tauri:invoke', pet, { cmd: 'plugin:event|listen', args: { event: 'tauri://move', handler: 9 } }),
    'handled:plugin:event|listen',
  );
  assert.equal(
    await ipcMain.invoke('tauri:invoke', main, { cmd: 'plugin:event|listen', args: { event: 'pet-position-changed', handler: 3 } }),
    'handled:plugin:event|listen',
  );
  assert.equal(await ipcMain.invoke('tauri:invoke', pet, { cmd: 'pet_set_frame', args: {} }), 'handled:pet_set_frame');
  assert.equal(await ipcMain.invoke('other-channel', pet, { cmd: 'plugin:event|listen' }), 'other');

  assert.deepEqual(listens, [
    { webContentsId: 42, event: 'tauri://move' },
    { webContentsId: 1, event: 'pet-position-changed' },
  ]);
});

test('the listen recorder tolerates malformed payloads and still forwards them', async () => {
  const ipcMain = fakeIpcMain();
  const listens = installEventListenRecorder(ipcMain);
  ipcMain.handle('tauri:invoke', async (_e, payload) => payload);
  assert.equal(await ipcMain.invoke('tauri:invoke', { id: 1 }, null), null);
  assert.equal(await ipcMain.invoke('tauri:invoke', { id: 1 }, 'nope'), 'nope');
  assert.deepEqual(listens, []);
});
