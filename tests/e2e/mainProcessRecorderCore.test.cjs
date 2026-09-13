'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { installWindowShowRecorder } = require('./mainProcessRecorderCore.cjs');

const MENU_BAR_BOTTOM = 33;

/**
 * A BrowserWindow stand-in with the macOS reveal contract described in
 * mainProcessRecorderCore.cjs: `show()` / `showInactive()` flip `isVisible()`
 * synchronously and apply the OS frame constraint (a frame above the menu bar
 * is pushed down to it) inside the call; the 'show' event arrives later and
 * separately, if at all.
 */
function fakeWindow(id, { visible = false, bounds = { x: 0, y: 0, width: 80, height: 80 } } = {}) {
  const win = new EventEmitter();
  win.id = id;
  win._visible = visible;
  win._bounds = { ...bounds };
  win._destroyed = false;
  win.isVisible = () => win._visible;
  win.isDestroyed = () => win._destroyed;
  win.getBounds = () => ({ ...win._bounds });
  win.setBounds = (b) => { win._bounds = { ...win._bounds, ...b }; };
  const reveal = () => {
    win._visible = true;
    if (win._bounds.y < MENU_BAR_BOTTOM) win._bounds.y = MENU_BAR_BOTTOM;
  };
  win.show = reveal;
  win.showInactive = reveal;
  return win;
}

function fakeApp() {
  return new EventEmitter();
}

test('a window revealed with show() is recorded at the moment of the call, before any show event', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(7, { bounds: { x: 240, y: 205, width: 80, height: 80 } });
  app.emit('browser-window-created', {}, win);

  assert.deepEqual(records, [{ id: 7, shownBounds: null }]);

  win.show();
  // No 'show' event has been emitted yet — the record must already be complete.
  assert.deepEqual(records[0], { id: 7, shownBounds: { x: 240, y: 205, width: 80, height: 80 } });
  assert.equal(win.isVisible(), true, 'the wrapped show() still reveals the window');
});

test('showInactive() (the ABU_E2E_QUIET_WINDOW reveal) is recorded the same way', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(3, { bounds: { x: 10, y: 40, width: 800, height: 600 } });
  app.emit('browser-window-created', {}, win);

  win.showInactive();
  assert.deepEqual(records[0].shownBounds, { x: 10, y: 40, width: 800, height: 600 });
  assert.equal(win.isVisible(), true);
});

test('the record holds the frame as presented, after the reveal applied the OS constraint', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(9, { bounds: { x: 400, y: 5, width: 80, height: 80 } });
  app.emit('browser-window-created', {}, win);

  win.show();
  assert.deepEqual(records[0].shownBounds, { x: 400, y: MENU_BAR_BOTTOM, width: 80, height: 80 });
});

test('a window constructed already visible (show: true) is recorded at creation', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(1, { visible: true, bounds: { x: 1, y: 40, width: 3, height: 4 } });
  app.emit('browser-window-created', {}, win);

  assert.deepEqual(records[0].shownBounds, { x: 1, y: 40, width: 3, height: 4 });
});

test('only the FIRST reveal is kept: later moves, show events and show() calls do not overwrite it', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(2, { bounds: { x: 240, y: 205, width: 80, height: 80 } });
  app.emit('browser-window-created', {}, win);

  win.show();
  win.setBounds({ x: 1290, y: 776 }); // a renderer-driven jump after first paint
  win.emit('show'); // the occlusion notification for the first reveal arrives late
  win.show(); // pet_show on an existing window re-shows it
  assert.deepEqual(records[0].shownBounds, { x: 240, y: 205, width: 80, height: 80 });
});

test('a reveal the recorder cannot capture synchronously leaves the record empty rather than falling back to the show event', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(5, { bounds: { x: 9, y: 40, width: 1, height: 1 } });
  app.emit('browser-window-created', {}, win);

  // e.g. a window ordered on screen by a path other than show()/showInactive():
  // only the asynchronous event would know, and that is the race being kept out.
  win._visible = true;
  win.emit('show');
  assert.equal(records[0].shownBounds, null);
});

test('a destroyed window is never queried for bounds', () => {
  const app = fakeApp();
  const records = installWindowShowRecorder(app);
  const win = fakeWindow(4);
  app.emit('browser-window-created', {}, win);
  win._destroyed = true;
  win.getBounds = () => { throw new Error('Object has been destroyed'); };
  win.show();
  assert.equal(records[0].shownBounds, null);
});
