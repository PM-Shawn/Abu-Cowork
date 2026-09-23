import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isValidNativeHelperIdentity,
  planWindowsDragFit,
  requiredNativeHelperCommands,
  WINDOWS_DRAG_DELTA,
} from './electron-packaged-smoke-contract.mjs';

function assertDraggable(plan, workArea) {
  assert.ok(plan.bounds.x >= workArea.x, 'fitted window starts left of the work area');
  assert.ok(plan.bounds.y >= workArea.y, 'fitted window starts above the work area');
  assert.ok(
    plan.bounds.x + plan.bounds.width + WINDOWS_DRAG_DELTA.x
      <= workArea.x + workArea.width,
    'fitted window leaves no room to drag right',
  );
  assert.ok(
    plan.bounds.y + plan.bounds.height + WINDOWS_DRAG_DELTA.y
      <= workArea.y + workArea.height,
    'fitted window leaves no room to drag down',
  );
}

function helloResponse(platform, supportedCommands) {
  return {
    id: 1,
    result: {
      protocol_version: 2,
      binary_version: '0.0.1',
      platform,
      started_at_ms: 1,
      supported_commands: supportedCommands,
      capabilities: {
        transport: 'ndjson-stdio',
        request_serialization: 'host',
        accessibility: platform === 'windows' ? 'windows-uia' : 'axui-element',
        screen_capture: platform === 'windows' ? 'wgc-monitor' : 'xcap',
        input: platform === 'windows' ? 'sendinput-guarded' : 'enigo',
        physical_input_monitoring: platform === 'windows',
      },
    },
  };
}

test('Windows handshake requires only commands implemented by the Windows helper', () => {
  const commands = requiredNativeHelperCommands('win32');
  assert.deepEqual(commands, [
    'health',
    'mouse_click',
    'capture_screen',
    'list_windows',
    'ax_snapshot',
    'mouse_drag',
  ]);
  assert.equal(
    isValidNativeHelperIdentity(
      helloResponse('windows', ['hello', ...commands]),
      0,
      'win32',
    ),
    true,
  );
});

test('macOS handshake additionally requires identity and AX commands', () => {
  const commonOnly = ['hello', ...requiredNativeHelperCommands('win32')];
  assert.equal(
    isValidNativeHelperIdentity(helloResponse('macos', commonOnly), 0, 'darwin'),
    false,
  );
  assert.equal(
    isValidNativeHelperIdentity(
      helloResponse('macos', ['hello', ...requiredNativeHelperCommands('darwin')]),
      0,
      'darwin',
    ),
    true,
  );
});

test('a window centred off a small display is moved into the work area', () => {
  // The CI display: a 1200x800 window centred on a 1024x728 work area starts
  // at (-88, -36), which puts its title-bar lane above the top of the screen.
  const workArea = { x: 0, y: 0, width: 1024, height: 728 };
  const plan = planWindowsDragFit({ x: -88, y: -36, width: 1200, height: 800 }, workArea);
  assert.equal(plan.fits, false);
  assert.deepEqual(plan.bounds, { x: 16, y: 16, width: 960, height: 680 });
  assertDraggable(plan, workArea);
});

test('a window that already has room to drag is left where it is', () => {
  const workArea = { x: 0, y: 0, width: 2560, height: 1400 };
  const bounds = { x: 680, y: 300, width: 1200, height: 800 };
  const plan = planWindowsDragFit(bounds, workArea);
  assert.equal(plan.fits, true);
  assert.deepEqual(plan.bounds, bounds);
});

test('a window flush against the work area edge is pulled back inside', () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  const plan = planWindowsDragFit({ x: 240, y: 100, width: 1200, height: 800 }, workArea);
  assert.equal(plan.fits, false);
  assertDraggable(plan, workArea);
});

test('the fit follows a work area that does not start at the origin', () => {
  // A taskbar docked left and a second display left of the primary one.
  const workArea = { x: -1920, y: 48, width: 1848, height: 1032 };
  const plan = planWindowsDragFit({ x: -2200, y: 20, width: 1200, height: 800 }, workArea);
  assert.equal(plan.fits, false);
  assert.deepEqual(plan.bounds, { x: -1904, y: 64, width: 1200, height: 800 });
  assertDraggable(plan, workArea);
});

test('handshake still fails closed on protocol or process failure', () => {
  const response = helloResponse('windows', requiredNativeHelperCommands('win32'));
  assert.equal(isValidNativeHelperIdentity(response, 1, 'win32'), false);
  response.result.protocol_version = 1;
  assert.equal(isValidNativeHelperIdentity(response, 0, 'win32'), false);
});
