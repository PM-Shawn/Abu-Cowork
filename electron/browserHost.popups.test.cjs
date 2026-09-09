'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

// Exercise the handler installed by the real host, not a copied URL validator.
function loadHost(t) {
  const electronId = require.resolve('electron');
  const tauriId = require.resolve('./tauriHost.cjs');
  const hostId = require.resolve('./browserHost.cjs');
  const previous = new Map([electronId, tauriId, hostId].map((id) => [id, require.cache[id]]));
  const created = [];
  class View {
    constructor() {
      const contents = new EventEmitter();
      Object.assign(contents, {
        id: 100 + created.length,
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
    webRequest: { onHeadersReceived() {} },
  });
  const window = {
    isDestroyed: () => false,
    webContents: new EventEmitter(),
    contentView: { addChildView() {} },
  };
  require.cache[electronId] = {
    id: electronId, filename: electronId, loaded: true,
    exports: { WebContentsView: View, session: { fromPartition: () => browserSession } },
  };
  require.cache[tauriId] = {
    id: tauriId, filename: tauriId, loaded: true,
    exports: { getMainWindow: () => window, emitEvent() {} },
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
  return { source: created[0].webContents, unrelated: created[1].webContents, created };
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

for (const [url, expected] of [
  ['https://example.com/article?q=one#section', 'https://example.com/article?q=one#section'],
  ['http://example.com/article', 'http://example.com/article'],
  ['HTTPS://EXAMPLE.COM', 'https://example.com/'],
]) {
  test(`popup preserves source-view navigation for ${url}`, (t) => {
    const { source, unrelated, created } = loadHost(t);
    assert.deepEqual(source.openWindow({ url }), { action: 'deny' });
    assert.deepEqual(source.loads, [expected]);
    assert.deepEqual(unrelated.loads, []);
    assert.equal(created.length, 2, 'http(s) popup still uses its source view');
  });
}
