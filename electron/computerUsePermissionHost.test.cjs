'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COMPUTER_USE_PERMISSION_HOST_MISS,
  SCREEN_RECORDING_SETTINGS_URL,
  createComputerUsePermissionHost,
} = require('./computerUsePermissionHost.cjs');

test('permission host ignores commands outside its consent surface', async () => {
  const dispatch = createComputerUsePermissionHost({
    platform: 'darwin',
    electronProvider: () => {
      throw new Error('Electron should not load for unrelated commands');
    },
  });

  assert.equal(
    await dispatch('mouse_click'),
    COMPUTER_USE_PERMISSION_HOST_MISS,
  );
});

test('macOS permission status is read from the Electron application identity', async () => {
  const accessibilityPrompts = [];
  const dispatch = createComputerUsePermissionHost({
    platform: 'darwin',
    electronProvider: () => ({
      desktopCapturer: {
        getSources: async () => [],
      },
      systemPreferences: {
        getMediaAccessStatus: (mediaType) => {
          assert.equal(mediaType, 'screen');
          return 'granted';
        },
        isTrustedAccessibilityClient: (prompt) => {
          accessibilityPrompts.push(prompt);
          return true;
        },
      },
    }),
  });

  assert.deepEqual(await dispatch('check_macos_permissions'), {
    screen_recording: true,
    accessibility: true,
    screen_recording_status: 'granted',
    accessibility_status: 'granted',
    restart_required: false,
  });
  assert.deepEqual(accessibilityPrompts, [false]);
});

test('granted Screen Recording with a failed functional probe requires relaunch', async () => {
  const dispatch = createComputerUsePermissionHost({
    platform: 'darwin',
    electronProvider: () => ({
      desktopCapturer: {
        getSources: async () => {
          throw new Error('current process has stale TCC state');
        },
      },
      systemPreferences: {
        getMediaAccessStatus: () => 'granted',
        isTrustedAccessibilityClient: () => true,
      },
    }),
  });

  assert.deepEqual(await dispatch('check_macos_permissions'), {
    screen_recording: false,
    accessibility: true,
    screen_recording_status: 'granted-relaunch-required',
    accessibility_status: 'granted',
    restart_required: true,
  });
});

test('Accessibility status moves from not-determined to pending user action', async () => {
  const prompts = [];
  const dispatch = createComputerUsePermissionHost({
    platform: 'darwin',
    electronProvider: () => ({
      desktopCapturer: { getSources: async () => [] },
      systemPreferences: {
        getMediaAccessStatus: () => 'not-determined',
        isTrustedAccessibilityClient: (prompt) => {
          prompts.push(prompt);
          return false;
        },
      },
    }),
  });

  assert.equal(
    (await dispatch('check_macos_permissions')).accessibility_status,
    'not-determined',
  );
  assert.equal(await dispatch('request_accessibility'), false);
  assert.equal(
    (await dispatch('check_macos_permissions')).accessibility_status,
    'pending-user-action',
  );
  assert.deepEqual(prompts, [false, true, false]);
});

test('Accessibility consent is requested by Electron itself', async () => {
  const prompts = [];
  const dispatch = createComputerUsePermissionHost({
    platform: 'darwin',
    electronProvider: () => ({
      desktopCapturer: {
        getSources: async () => {
          throw new Error('screen capture should not be requested');
        },
      },
      systemPreferences: {
        isTrustedAccessibilityClient: (prompt) => {
          prompts.push(prompt);
          return false;
        },
      },
    }),
  });

  assert.equal(await dispatch('request_accessibility'), false);
  assert.deepEqual(prompts, [true]);
});

test('first-time screen consent uses Electron desktop capture and rechecks status', async () => {
  const statuses = ['not-determined', 'granted'];
  let sourceRequests = 0;
  const dispatch = createComputerUsePermissionHost({
    platform: 'darwin',
    electronProvider: () => ({
      desktopCapturer: {
        getSources: async (options) => {
          sourceRequests += 1;
          assert.deepEqual(options, {
            types: ['screen'],
            thumbnailSize: { width: 1, height: 1 },
            fetchWindowIcons: false,
          });
          return [];
        },
      },
      shell: {
        openExternal: async () => {
          throw new Error('settings should not open for first-time consent');
        },
      },
      systemPreferences: {
        getMediaAccessStatus: () => statuses.shift(),
      },
    }),
  });

  assert.equal(await dispatch('request_screen_recording'), true);
  assert.equal(sourceRequests, 1);
});

test('previously denied screen consent opens the exact System Settings pane', async () => {
  const opened = [];
  const dispatch = createComputerUsePermissionHost({
    platform: 'darwin',
    electronProvider: () => ({
      desktopCapturer: {
        getSources: async () => {
          throw new Error('capture should not retry after an existing denial');
        },
      },
      shell: {
        openExternal: async (url) => opened.push(url),
      },
      systemPreferences: {
        getMediaAccessStatus: () => 'denied',
      },
    }),
  });

  assert.equal(await dispatch('request_screen_recording'), false);
  assert.deepEqual(opened, [SCREEN_RECORDING_SETTINGS_URL]);
});

test('non-macOS requests preserve the existing no-op behavior', async () => {
  const dispatch = createComputerUsePermissionHost({
    platform: 'win32',
    electronProvider: () => {
      throw new Error('Electron should not load for the no-op path');
    },
  });

  assert.equal(await dispatch('request_accessibility'), true);
  assert.equal(await dispatch('request_screen_recording'), true);
  assert.equal(
    await dispatch('check_macos_permissions'),
    COMPUTER_USE_PERMISSION_HOST_MISS,
  );
});
