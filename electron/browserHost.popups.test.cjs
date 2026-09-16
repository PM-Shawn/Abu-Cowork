'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

// Exercise the handler installed by the real host, not a copied URL validator.
function loadHost(t, confirm = () => 0) {
  const electronId = require.resolve('electron');
  const tauriId = require.resolve('./tauriHost.cjs');
  const hostId = require.resolve('./browserHost.cjs');
  const previous = new Map([electronId, tauriId, hostId].map((id) => [id, require.cache[id]]));
  const created = [];
  const events = [];
  class View {
    constructor(options = {}) {
      const contents = options.webContents || new EventEmitter();
      Object.assign(contents, {
        id: contents.id || 100 + created.length,
        getURL: () => 'https://source.example/',
        loads: [],
        isDestroyed: () => false,
        setWindowOpenHandler(handler) { this.openWindow = handler; },
        loadURL(url) { this.loads.push(url); return Promise.resolve(); },
      });
      this.webContents = contents;
      created.push(this);
    }
    setBounds() {}
    setVisible() {}
  }
  const browserSession = Object.assign(new EventEmitter(), {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    webRequest: { onBeforeRequest() {}, onHeadersReceived() {} },
  });
  const window = {
    isDestroyed: () => false,
    webContents: new EventEmitter(),
    contentView: { addChildView() {} },
  };
  require.cache[electronId] = {
    id: electronId, filename: electronId, loaded: true,
    exports: { dialog: { showMessageBoxSync: confirm }, WebContentsView: View, session: { fromPartition: () => browserSession } },
  };
  require.cache[tauriId] = {
    id: tauriId, filename: tauriId, loaded: true,
    exports: { getMainWindow: () => window, emitEvent(name, payload) { events.push({ name, payload }); } },
  };
  delete require.cache[hostId];
  t.after(() => {
    for (const [id, cached] of previous) {
      if (cached) require.cache[id] = cached;
      else delete require.cache[id];
    }
  });
  const host = require('./browserHost.cjs');
  for (const id of ['source', 'unrelated']) {
    host.browserDispatch(null, 'browser_create', {
      id, url: 'https://source.example/', x: 0, y: 0, width: 800, height: 600,
    });
  }
  for (const view of created) view.webContents.loads.length = 0;
  return { host, source: created[0].webContents, unrelated: created[1].webContents, created, events };
}

for (const url of [
  'file:///tmp/private.txt',
  'javascript:alert(1)',
  'chrome://settings',
  'data:text/html,<h1>not allowed</h1>',
  'about:blank',
  'https://[',
  'not a URL',
  '',
]) {
  test(`popup refuses ${JSON.stringify(url)} without navigating any view`, (t) => {
    const { source, unrelated, created } = loadHost(t);
    assert.deepEqual(source.openWindow({ url }), { action: 'deny' });
    assert.deepEqual(source.loads, []);
    assert.deepEqual(unrelated.loads, []);
    assert.equal(created.length, 2, 'a refused popup must not create a view');
  });
}

for (const url of ['https://example.com/article', 'http://example.com/article', 'HTTPS://EXAMPLE.COM']) {
  test(`manual popup adopts a native child without loading its source: ${url}`, async (t) => {
    const { host, source, unrelated, created, events } = loadHost(t);
    const response = source.openWindow({ url });
    assert.equal(response.action, 'allow');
    assert.equal(response.outlivesOpener, true);
    assert.equal(response.overrideBrowserWindowOptions.webPreferences.sandbox, true);
    assert.equal(response.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
    assert.equal(response.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
    assert.equal(response.overrideBrowserWindowOptions.webPreferences.preload, undefined);
    const nativeChild = Object.assign(new EventEmitter(), { id: 301 });
    assert.equal(response.createWindow({ webContents: nativeChild, webPreferences: response.overrideBrowserWindowOptions.webPreferences }), nativeChild);
    assert.deepEqual(source.loads, []);
    assert.deepEqual(unrelated.loads, []);
    assert.deepEqual(nativeChild.loads, [], 'Chromium alone dispatches the native request');
    assert.equal(created.length, 3);
    // No synthetic URL replay is allowed during renderer adoption, even when
    // it carries the original POST endpoint rather than the final redirect.
    await Promise.resolve();
    assert.equal(events.find(event => event.name === 'browser://automation-open').payload.sourceViewId, 'source');
    void host;
  });
}

for (const accepted of [false, true]) {
  test(`human popup confirmation ${accepted ? 'preserves native POST' : 'denies without replay'}`, async (t) => {
    const prompts = [];
    const { host, source } = loadHost(t, (_win, options) => { prompts.push(options); return accepted ? 1 : 0; });
    await host.browserDispatch(null, 'browser_control', { id: 'source', action: 'take', locale: 'zh-CN' });
    const decision = source.openWindow({ url: 'https://other.example/form', postBody: { data: [{ bytes: Buffer.from('private form') }] } });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].defaultId, 0);
    assert.equal(prompts[0].cancelId, 0);
    assert.match(prompts[0].detail, /https:\/\/other.example\/form/);
    assert.match(prompts[0].detail, /提交表单/);
    assert.equal(prompts[0].detail.includes('private form'), false);
    assert.equal(decision.action, accepted ? 'allow' : 'deny');
    assert.deepEqual(source.loads, []);
    if (!accepted) {
      assert.equal(source.openWindow({ url: 'https://other.example/again' }).action, 'deny');
      assert.equal(prompts.length, 1);
    } else {
      const nativeChild = Object.assign(new EventEmitter(), { id: 501 });
      assert.equal(decision.createWindow({ webContents: nativeChild, webPreferences: decision.overrideBrowserWindowOptions.webPreferences }), nativeChild);
      assert.deepEqual(nativeChild.loads, []);
      source.emit('destroyed');
      assert.equal(host.browserDispatch(null, 'browser_control', { id: 'source' }), 'ai');
      await assert.rejects(host.performBrowserAutomation('snapshot', { tabId: nativeChild.id }), /user has taken control/);
    }
  });
}
