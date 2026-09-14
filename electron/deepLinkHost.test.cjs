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
    isDefaultProtocolClient() { return true; },
  };
}

const deps = {
  emitEvent() { return 0; },
  getMainWindow() { return null; },
};

test.afterEach(() => deepLinkHost.__resetForTest());

test('accepts every account and enterprise action through one auth callback', () => {
  assert.equal(
    deepLinkHost.normalizeDeepLinkUrl('abu://open?server=https://console.example.com'),
    'abu://open?server=https://console.example.com',
  );
  assert.equal(
    deepLinkHost.normalizeDeepLinkUrl('abu://enroll?server=https://console.example.com&token=one'),
    'abu://enroll?server=https://console.example.com&token=one',
  );
  assert.equal(
    deepLinkHost.normalizeDeepLinkUrl('abu://auth?code=one&state=csrf'),
    'abu://auth?code=one&state=csrf',
  );
  assert.equal(
    deepLinkHost.normalizeDeepLinkUrl('abu://login?code=one&state=csrf'),
    null,
  );
});

test('rewrites abu-dev only for an unpackaged app', () => {
  deepLinkHost.initDeepLink(fakeApp(false), deps);
  assert.equal(
    deepLinkHost.normalizeDeepLinkUrl('abu-dev://auth?code=one&state=csrf'),
    'abu://auth?code=one&state=csrf',
  );

  deepLinkHost.__resetForTest();
  deepLinkHost.initDeepLink(fakeApp(true), deps);
  assert.equal(
    deepLinkHost.normalizeDeepLinkUrl('abu-dev://auth?code=one&state=csrf'),
    null,
  );
});

test('resolves and exposes the scheme the shell can receive', () => {
  assert.equal(deepLinkHost.resolveDeepLinkScheme(fakeApp(true)), 'abu');
  assert.equal(deepLinkHost.resolveDeepLinkScheme(fakeApp(false)), 'abu-dev');

  deepLinkHost.initDeepLink(fakeApp(false), deps);
  assert.equal(deepLinkHost.getActiveScheme(), 'abu-dev');

  deepLinkHost.__resetForTest();
  deepLinkHost.initDeepLink(fakeApp(true), deps);
  assert.equal(deepLinkHost.getActiveScheme(), 'abu');
});

test('registers and queries the scheme used by the current shell', () => {
  const registered = [];
  const queried = [];
  const app = fakeApp(false);
  app.setAsDefaultProtocolClient = (...args) => { registered.push(args); return true; };
  app.isDefaultProtocolClient = (...args) => { queried.push(args); return true; };

  deepLinkHost.initDeepLink(app, deps);

  assert.equal(deepLinkHost.isCurrentSchemeRegistered(app), true);
  assert.equal(queried[0][0], 'abu-dev');
  assert.deepEqual(queried[0], registered[0]);
});

test('keeps registration query failures distinct from not registered', () => {
  const notRegistered = fakeApp(true);
  notRegistered.isDefaultProtocolClient = () => false;
  deepLinkHost.initDeepLink(notRegistered, deps);
  assert.equal(deepLinkHost.isCurrentSchemeRegistered(notRegistered), false);
  assert.throws(
    () => deepLinkHost.isCurrentSchemeRegistered({ isReady: () => false }),
    /deep_link_registration_not_ready/,
  );
  assert.throws(
    () => deepLinkHost.isCurrentSchemeRegistered({
      isReady: () => true,
      isDefaultProtocolClient() { throw new Error('registry unavailable'); },
    }),
    /registry unavailable/,
  );
});

test('rejects OAuth callbacks with path, fragment, or userinfo', () => {
  assert.equal(deepLinkHost.normalizeDeepLinkUrl('abu://auth/path?code=c&state=s'), null);
  assert.equal(deepLinkHost.normalizeDeepLinkUrl('abu://auth?code=c&state=s#fragment'), null);
  assert.equal(deepLinkHost.normalizeDeepLinkUrl('abu://user@auth?code=c&state=s'), null);
});

test('never logs OAuth codes or state while preserving accepted payloads', () => {
  const listeners = new Map();
  const logs = [];
  const delivered = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(' '));
  try {
    deepLinkHost.initDeepLink({
      isPackaged: false,
      isReady: () => true,
      setAsDefaultProtocolClient() {},
      on(event, handler) { listeners.set(event, handler); },
    }, {
      emitEvent: (_event, payload) => { delivered.push(...payload); return 1; },
      getMainWindow: () => null,
    });
    listeners.get('open-url')(
      { preventDefault() {} },
      'abu-dev://auth?code=ACCOUNT_CODE&state=ACCOUNT_STATE',
    );
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(delivered, [
    'abu://auth?code=ACCOUNT_CODE&state=ACCOUNT_STATE',
  ]);
  const output = logs.join('\n');
  assert.doesNotMatch(output, /ACCOUNT_CODE|ACCOUNT_STATE/);
});

test('never logs secrets from malformed OAuth-like URLs', () => {
  const listeners = new Map();
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(' '));
  try {
    deepLinkHost.initDeepLink({
      isPackaged: false,
      isReady: () => false,
      setAsDefaultProtocolClient() {},
      on(event, handler) { listeners.set(event, handler); },
    }, deps);
    for (const host of ['auth', 'login']) {
      listeners.get('open-url')(
        { preventDefault() {} },
        `abu://${host}:bad?code=${host.toUpperCase()}_CODE&state=${host.toUpperCase()}_STATE`,
      );
    }
  } finally {
    console.log = originalLog;
  }
  const output = logs.join('\n');
  assert.doesNotMatch(output, /AUTH_CODE|AUTH_STATE|LOGIN_CODE|LOGIN_STATE/);
});

test('activates the macOS app when a running deep link arrives', {
  skip: process.platform !== 'darwin',
}, () => {
  const listeners = new Map();
  const calls = [];
  const app = fakeApp(false);
  app.on = (event, handler) => listeners.set(event, handler);
  app.focus = options => calls.push(['app.focus', options]);

  deepLinkHost.initDeepLink(app, {
    emitEvent: () => 1,
    getMainWindow: () => ({
      isMinimized: () => true,
      restore: () => calls.push(['window.restore']),
      show: () => calls.push(['window.show']),
      focus: () => calls.push(['window.focus']),
    }),
  });

  listeners.get('open-url')(
    { preventDefault() {} },
    'abu-dev://auth?code=one&state=csrf',
  );

  assert.deepEqual(calls, [
    ['window.restore'],
    ['window.show'],
    ['window.focus'],
    ['app.focus', { steal: true }],
  ]);
});
