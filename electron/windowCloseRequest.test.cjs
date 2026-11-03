'use strict';

/**
 * The window close button's `close-requested` event (wireWindowEvents in
 * tauriHost.cjs) carries the running background commands, so the renderer's
 * close dialog opens with their count and reads nothing itself.
 *
 * tauriHost.cjs destructures from `electron` at load time, so the `electron`
 * cache slot is pre-filled with a fake BEFORE it is required — same technique
 * as windowPlacement.test.cjs.
 */

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { registerRendererCallbackContext } = require('./rendererCallbackContext.cjs');

const electronId = require.resolve('electron');
require.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  exports: {
    screen: {},
    app: { isPackaged: false },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    ipcMain: {},
    nativeTheme: {},
    dialog: {},
  },
};

const tauriHost = require('./tauriHost.cjs');
const { installBackgroundCommands } = require('./commandHost.cjs');

const table = { running: 0, register() {}, runningCount() { return this.running; } };
installBackgroundCommands(table);

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }
  isDestroyed() { return false; }
  send(channel, message) { this.sent.push({ channel, message }); }
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new FakeWebContents();
  }
  isDestroyed() { return false; }
}

function closeWindow(win) {
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  win.emit('close', event);
  return event;
}

test('close-requested carries the count of running background commands', (t) => {
  t.after(() => tauriHost.__test.clearSubscriptions());
  const win = new FakeWindow();
  tauriHost.wireWindowEvents(win);
  registerRendererCallbackContext(win.webContents, 'close-test');
  tauriHost.__test.subscribe('close-requested', 7, win.webContents, 'close-test');

  table.running = 2;
  assert.equal(closeWindow(win).defaultPrevented, true);
  table.running = 0;
  closeWindow(win);

  assert.deepEqual(
    win.webContents.sent.map(({ message }) => [message.id, message.payload.event, message.payload.payload]),
    [
      [7, 'close-requested', { backgroundCommandCount: 2 }],
      [7, 'close-requested', { backgroundCommandCount: 0 }],
    ],
  );
});

test('a close before the page listens is let through and sends nothing', (t) => {
  t.after(() => tauriHost.__test.clearSubscriptions());
  const win = new FakeWindow();
  tauriHost.wireWindowEvents(win);

  assert.equal(closeWindow(win).defaultPrevented, false);
  assert.deepEqual(win.webContents.sent, []);
});
