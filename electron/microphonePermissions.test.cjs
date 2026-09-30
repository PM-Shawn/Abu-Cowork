'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MACOS_MICROPHONE_SETTINGS_URL,
  WINDOWS_MICROPHONE_SETTINGS_URL,
  createMicrophoneHost,
  installMicrophonePermissions,
} = require('./microphonePermissions.cjs');

const MAIN_PAGE = 'file:///app/dist-electron-spike/index.html';
const mainContents = { id: 'main' };
const otherContents = { id: 'other' };

function setup({ platform = 'darwin', status = 'granted', ask = async () => true } = {}) {
  const handlers = {};
  const asked = [];
  installMicrophonePermissions({
    setPermissionCheckHandler: (handler) => { handlers.check = handler; },
    setPermissionRequestHandler: (handler) => { handlers.request = handler; },
  }, {
    platform,
    systemPreferences: {
      getMediaAccessStatus: () => status,
      askForMediaAccess: async (type) => { asked.push(type); return ask(); },
    },
    isTrustedMainWindowPage: (contents, url) => contents === mainContents && url === MAIN_PAGE,
  });
  const request = (contents, permission, details) => new Promise((resolve) => {
    handlers.request(contents, permission, resolve, details);
  });
  return { handlers, request, asked };
}

const audioRequest = { mediaTypes: ['audio'], isMainFrame: true, requestingUrl: MAIN_PAGE };

test('non-media permissions keep Electron defaults', async () => {
  const { handlers, request } = setup();
  assert.equal(await request(otherContents, 'notifications', {}), true);
  assert.equal(handlers.check(otherContents, 'clipboard-read', 'file:///', {}), true);
});

test('macOS audio request from the main page asks the OS', async () => {
  const { request, asked } = setup({ ask: async () => true });
  assert.equal(await request(mainContents, 'media', audioRequest), true);
  assert.deepEqual(asked, ['microphone']);
});

test('macOS denial from the OS denies the request', async () => {
  const { request } = setup({ ask: async () => false });
  assert.equal(await request(mainContents, 'media', audioRequest), false);
});

test('a rejected OS prompt denies instead of hanging', async () => {
  const { request } = setup({ ask: async () => { throw new Error('tcc'); } });
  assert.equal(await request(mainContents, 'media', audioRequest), false);
});

test('Windows grants trusted audio requests without an OS prompt', async () => {
  const { request, asked } = setup({ platform: 'win32' });
  assert.equal(await request(mainContents, 'media', audioRequest), true);
  assert.deepEqual(asked, []);
});

test('video, screen and mixed media requests are denied', async () => {
  const { request, asked } = setup();
  for (const mediaTypes of [['video'], ['audio', 'video'], [], undefined]) {
    assert.equal(await request(mainContents, 'media', { ...audioRequest, mediaTypes }), false);
  }
  assert.deepEqual(asked, []);
});

test('subframes, other WebContents and other pages are denied', async () => {
  const { request, asked } = setup();
  assert.equal(await request(mainContents, 'media', { ...audioRequest, isMainFrame: false }), false);
  assert.equal(await request(otherContents, 'media', audioRequest), false);
  assert.equal(await request(mainContents, 'media', { ...audioRequest, requestingUrl: 'https://evil.example/' }), false);
  assert.deepEqual(asked, []);
});

test('permission checks require audio, the trusted page and OS consent', () => {
  const details = { mediaType: 'audio', isMainFrame: true, requestingUrl: MAIN_PAGE };
  assert.equal(setup({ status: 'granted' }).handlers.check(mainContents, 'media', 'file:///', details), true);
  assert.equal(setup({ status: 'not-determined' }).handlers.check(mainContents, 'media', 'file:///', details), false);
  assert.equal(setup({ status: 'denied' }).handlers.check(mainContents, 'media', 'file:///', details), false);
  const { check } = setup().handlers;
  assert.equal(check(mainContents, 'media', 'file:///', { ...details, mediaType: 'video' }), false);
  assert.equal(check(null, 'media', 'file:///', details), false);
});

test('microphone host reports OS status per platform', async () => {
  const withStatus = (platform, status) => createMicrophoneHost({
    platform,
    systemPreferences: { getMediaAccessStatus: () => status },
    openExternal: async () => {},
  });
  assert.equal(await withStatus('darwin', 'denied')('status'), 'denied');
  assert.equal(await withStatus('win32', 'granted')('status'), 'granted');
  assert.equal(await withStatus('darwin', 'bogus')('status'), 'unknown');
  assert.equal(await withStatus('linux', 'denied')('status'), 'granted');
});

test('microphone host opens only the platform privacy page', async () => {
  const opened = [];
  const open = (platform) => createMicrophoneHost({ platform, openExternal: async (url) => { opened.push(url); } });
  assert.equal(await open('darwin')('open-settings'), true);
  assert.equal(await open('win32')('open-settings'), true);
  assert.equal(await open('linux')('open-settings'), false);
  assert.deepEqual(opened, [MACOS_MICROPHONE_SETTINGS_URL, WINDOWS_MICROPHONE_SETTINGS_URL]);
  await assert.rejects(open('darwin')('https://evil.example'), /unsupported action/);
});
