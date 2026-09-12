'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const deepLinkHost = require('./deepLinkHost.cjs');

function fakeApp(isPackaged) {
  return {
    isPackaged,
    on() {},
    isReady() { return true; },
    setAsDefaultProtocolClient() { return true; },
  };
}

const deps = {
  emitEvent() { return 0; },
  getMainWindow() { return null; },
};

test.afterEach(() => deepLinkHost.__resetForTest());

test('accepts the credential-free open host', () => {
  assert.equal(
    deepLinkHost.normalizeDeepLinkUrl('abu://open?server=https://console.example.com'),
    'abu://open?server=https://console.example.com',
  );
});

test('rewrites abu-dev only for an unpackaged app', () => {
  deepLinkHost.initDeepLink(fakeApp(false), deps);
  assert.equal(
    deepLinkHost.normalizeDeepLinkUrl('abu-dev://login?code=one&state=csrf'),
    'abu://login?code=one&state=csrf',
  );

  deepLinkHost.__resetForTest();
  deepLinkHost.initDeepLink(fakeApp(true), deps);
  assert.equal(
    deepLinkHost.normalizeDeepLinkUrl('abu-dev://login?code=one&state=csrf'),
    null,
  );
});
