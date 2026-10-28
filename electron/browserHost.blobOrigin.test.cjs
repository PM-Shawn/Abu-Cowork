'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// B3（2026-10-27）：blob: 内层 origin 提取与弹窗 URL 白名单，纯函数直测
// （__testing 导出）。宿主加载只需要最小的 electron 假体。
function loadHost(t) {
  const electronId = require.resolve('electron');
  const tauriId = require.resolve('./tauriHost.cjs');
  const hostId = require.resolve('./browserHost.cjs');
  const previous = new Map([electronId, tauriId, hostId].map((id) => [id, require.cache[id]]));
  require.cache[electronId] = {
    id: electronId, filename: electronId, loaded: true,
    exports: {
      WebContentsView: class { setBounds() {} setVisible() {} },
      session: { fromPartition: () => Object.assign(new (require('node:events').EventEmitter)(), {
        setPermissionCheckHandler() {}, setPermissionRequestHandler() {},
        webRequest: { onBeforeRequest() {}, onHeadersReceived() {} },
      }) },
    },
  };
  require.cache[tauriId] = {
    id: tauriId, filename: tauriId, loaded: true,
    exports: { getMainWindow: () => ({ isDestroyed: () => true }), emitEvent() {} },
  };
  delete require.cache[hostId];
  t.after(() => {
    for (const [id, cached] of previous) {
      if (cached) require.cache[id] = cached;
      else delete require.cache[id];
    }
  });
  return require('./browserHost.cjs').__testing;
}

test('normalizedOriginOf strips blob: to the inner http(s) origin (B3)', (t) => {
  const { normalizedOriginOf } = loadHost(t);
  assert.equal(normalizedOriginOf('blob:https://example.com/uuid-1'), 'https://example.com');
  assert.equal(normalizedOriginOf('blob:http://example.com:8080/x'), 'http://example.com:8080');
  assert.equal(normalizedOriginOf('https://example.com/page'), 'https://example.com', 'non-blob behaviour unchanged');
  assert.equal(normalizedOriginOf('data:text/html,x'), null, 'data: stays unverifiable');
  assert.equal(normalizedOriginOf('blob:data:text/html,x'), null, 'blob over data: gains nothing');
  assert.equal(normalizedOriginOf('garbage'), null);
  assert.equal(normalizedOriginOf(''), null);
});

test('allowedAutomationUrl admits blob: only through the popup gate (B3)', (t) => {
  const { allowedAutomationUrl } = loadHost(t);
  assert.equal(allowedAutomationUrl('blob:https://example.com/x', { allowBlob: true }), 'blob:https://example.com/x');
  assert.throws(() => allowedAutomationUrl('blob:https://example.com/x'), /Invalid URL scheme/, 'navigate stays strict');
  assert.throws(() => allowedAutomationUrl('blob:file:///tmp/x', { allowBlob: true }), /Invalid URL scheme/);
  assert.throws(() => allowedAutomationUrl('blob:data:text/html,x', { allowBlob: true }));
  assert.equal(allowedAutomationUrl('https://example.com/x'), 'https://example.com/x');
});
