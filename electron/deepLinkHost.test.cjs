'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  __resetForTest,
  initDeepLink,
  isCurrentSchemeRegistered,
  normalizeDeepLinkUrl,
} = require('./deepLinkHost.cjs');

test.afterEach(() => __resetForTest());

test('accepts the auth host and canonicalizes the development scheme', () => {
  assert.equal(
    normalizeDeepLinkUrl('abu-dev://auth?code=one-time-code&state=csrf-state'),
    'abu://auth?code=one-time-code&state=csrf-state',
  );
});

test('queries registration for the scheme used by the current shell', () => {
  const registered = [];
  const queried = [];
  const app = {
    isPackaged: false,
    isReady: () => true,
    setAsDefaultProtocolClient(...args) { registered.push(args); },
    isDefaultProtocolClient(...args) {
      queried.push(args);
      return true;
    },
    on() {},
  };
  initDeepLink(app, { emitEvent: () => 0, getMainWindow: () => null });
  assert.equal(isCurrentSchemeRegistered(app), true);
  assert.equal(queried[0][0], 'abu-dev');
  assert.deepEqual(queried[0], registered[0]);
});

test('keeps registration query failures distinct from not registered', () => {
  const notRegistered = {
    isPackaged: true,
    isReady: () => true,
    setAsDefaultProtocolClient() {},
    isDefaultProtocolClient: () => false,
    on() {},
  };
  initDeepLink(notRegistered, { emitEvent: () => 0, getMainWindow: () => null });
  assert.equal(isCurrentSchemeRegistered(notRegistered), false);
  assert.throws(
    () => isCurrentSchemeRegistered({ isReady: () => false }),
    /deep_link_registration_not_ready/,
  );
  assert.throws(
    () => isCurrentSchemeRegistered({
      isReady: () => true,
      isDefaultProtocolClient() { throw new Error('registry unavailable'); },
    }),
    /registry unavailable/,
  );
});

test('rejects an auth callback with path, fragment, or userinfo', () => {
  assert.equal(normalizeDeepLinkUrl('abu://auth/path?code=c&state=s'), null);
  assert.equal(normalizeDeepLinkUrl('abu://auth?code=c&state=s#fragment'), null);
  assert.equal(normalizeDeepLinkUrl('abu://user@auth?code=c&state=s'), null);
});

test('never logs an auth code or state while preserving the forwarded payload', () => {
  const listeners = new Map();
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(' '));
  try {
    initDeepLink({
      isPackaged: false,
      isReady: () => false,
      setAsDefaultProtocolClient() {},
      on(event, handler) { listeners.set(event, handler); },
    }, {
      emitEvent: () => 0,
      getMainWindow: () => null,
    });
    const event = { preventDefault() {} };
    listeners.get('open-url')(event, 'abu-dev://auth?code=one-time-code&state=csrf-state');
  } finally {
    console.log = originalLog;
  }
  const output = logs.join('\n');
  assert.match(output, /"host":"auth"/);
  assert.doesNotMatch(output, /one-time-code|csrf-state/);
});

test('never logs secrets from a malformed auth-like URL', () => {
  const listeners = new Map();
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(' '));
  try {
    initDeepLink({
      isPackaged: false,
      isReady: () => false,
      setAsDefaultProtocolClient() {},
      on(event, handler) { listeners.set(event, handler); },
    }, {
      emitEvent: () => 0,
      getMainWindow: () => null,
    });
    listeners.get('open-url')(
      { preventDefault() {} },
      'abu://auth:bad?code=AUTH_CODE_SENTINEL&state=STATE_SENTINEL',
    );
  } finally {
    console.log = originalLog;
  }
  const output = logs.join('\n');
  assert.match(output, /"host":"auth"/);
  assert.doesNotMatch(output, /AUTH_CODE_SENTINEL|STATE_SENTINEL/);
});
