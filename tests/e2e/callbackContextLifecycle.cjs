'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { BrowserWindow, app, globalShortcut, ipcMain } = require('electron');
const fs = require('node:fs');
const { registerPrivilegedWindow } = require('../../electron/securityBoundary.cjs');

const contexts = new Map();
const windows = new Map();
const registrations = [];
let pendingNavigation;
let invokeHandler;
let contextHandler;
let watchesOpened = 0;
let watchesClosed = 0;

const registerInvoke = ipcMain.handle;
ipcMain.handle = function (channel, handler) {
  if (channel === 'tauri:invoke') invokeHandler = handler;
  return registerInvoke.call(this, channel, handler);
};
const registerListener = ipcMain.on;
ipcMain.on = function (channel, handler) {
  if (channel === 'tauri:callback-context') contextHandler = handler;
  return registerListener.call(this, channel, handler);
};
const nativeWatch = fs.watch;
fs.watch = function (...args) {
  const watcher = nativeWatch.apply(this, args);
  if (String(args[0]).endsWith('callback-context-watch.txt')) {
    watchesOpened++;
    watcher.once('close', () => { watchesClosed++; });
  }
  return watcher;
};

globalThis.__abuCallbackContextAcceptance = {
  async create(gui, registered = true) {
    const page = path.join(__dirname, 'fixtures/callback-context.html');
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../../electron', gui ? 'guiTauriGlobalPreload.cjs' : 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegrationInSubFrames: true,
      },
    });
    windows.set(win.id, win);
    win.webContents.on('ipc-message-sync', (_event, channel, contextId) => {
      if (channel === 'tauri:callback-context') {
        registrations.push({ id: win.id, mainFrame: _event.senderFrame === win.webContents.mainFrame });
        if (_event.senderFrame === win.webContents.mainFrame) contexts.set(win.id, contextId);
      }
    });
    if (registered) registerPrivilegedWindow(win, page, { label: gui ? 'overlay' : 'main' });
    require('../../electron/tauriHost.cjs').wireWindowEvents(win);
    await win.loadFile(page);
    return win.id;
  },
  context(id) { return contexts.get(id); },
  registrations(id) { return registrations.filter(entry => entry.id === id); },
  resources(id) {
    return { shortcut: globalShortcut.isRegistered('CommandOrControl+Shift+F20'), destroyedListeners: windows.get(id).webContents.listenerCount('destroyed'), watchesOpened, watchesClosed };
  },
  watchPath() {
    const file = path.join(app.getPath('temp'), 'callback-context-watch.txt');
    fs.writeFileSync(file, 'watch');
    return file;
  },
  async reload(id) {
    const contents = windows.get(id).webContents;
    await contents.loadURL(contents.getURL());
  },
  subscriptions(id) {
    return require('../../electron/tauriHost.cjs').__test.subscribedEvents(windows.get(id).webContents);
  },
  deliver(id, contextId, value, remove = false) {
    windows.get(id).webContents.send(remove ? 'tauri:uncallback' : 'tauri:callback', {
      id: 1, contextId, payload: { event: 'computer-use-status', id: 1, payload: value },
    });
  },
  emit(id, value) {
    return require('../../electron/tauriHost.cjs').emitWindowEvent(windows.get(id), 'computer-use-status', value);
  },
  startNavigation(id, url) {
    pendingNavigation = assert.rejects(windows.get(id).webContents.loadURL(url), /ERR_(ABORTED|FAILED)/);
  },
  startHeldNavigation(id, url) {
    pendingNavigation = windows.get(id).webContents.loadURL(url);
  },
  finishNavigation() { return pendingNavigation; },
  async verifySuspendedInvokes(id) {
    const sender = windows.get(id).webContents;
    const event = { sender, senderFrame: sender.mainFrame };
    const first = contexts.get(id);
    const listen = { cmd: 'plugin:event|listen', args: { event: 'computer-use-status', handler: 1 } };
    const eventId = await invokeHandler(event, listen, first);
    contextHandler(event, first);
    assert.deepEqual(event.returnValue, { ok: true, contextId: first });
    assert.deepEqual(this.subscriptions(id), ['computer-use-status']);
    const oldListen = invokeHandler(event, listen, first);
    const oldUnlisten = invokeHandler(event, { cmd: 'plugin:event|unlisten', args: { event: 'computer-use-status', eventId } }, first);
    const second = `${first}:replacement-boundary`;
    contextHandler(event, second);
    assert.deepEqual(event.returnValue, { ok: true, contextId: second });
    await assert.rejects(oldListen, /no longer active/);
    await assert.rejects(oldUnlisten, /no longer active/);
    const currentId = await invokeHandler(event, listen, second);
    assert.deepEqual(this.subscriptions(id), ['computer-use-status']);
    assert.equal(await invokeHandler(event, { cmd: 'plugin:event|unlisten', args: { event: 'computer-use-status', eventId: currentId } }, second), null);
    assert.deepEqual(this.subscriptions(id), []);
  },
  async cancelNavigation(id) {
    windows.get(id).webContents.stop();
    await pendingNavigation;
  },
  async errorPage(id) {
    await assert.rejects(windows.get(id).loadFile(path.join(app.getPath('temp'), 'missing-callback-page.html')), /ERR_FILE_NOT_FOUND/);
  },
  async crash(id) {
    const contents = windows.get(id).webContents;
    const gone = new Promise(resolve => contents.once('render-process-gone', resolve));
    contents.forcefullyCrashRenderer();
    await gone;
  },
  destroy(id) {
    windows.get(id).destroy();
    windows.delete(id);
    contexts.delete(id);
  },
};
