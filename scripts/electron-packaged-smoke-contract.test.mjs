import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isValidNativeHelperIdentity,
  requiredNativeHelperCommands,
} from './electron-packaged-smoke-contract.mjs';

function helloResponse(platform, supportedCommands) {
  return {
    id: 1,
    result: {
      protocol_version: 1,
      binary_version: '0.0.1',
      platform,
      started_at_ms: 1,
      supported_commands: supportedCommands,
    },
  };
}

test('Windows handshake requires only commands implemented by the Windows helper', () => {
  const commands = requiredNativeHelperCommands('win32');
  assert.deepEqual(commands, ['health', 'mouse_click', 'capture_screen']);
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

test('handshake still fails closed on protocol or process failure', () => {
  const response = helloResponse('windows', requiredNativeHelperCommands('win32'));
  assert.equal(isValidNativeHelperIdentity(response, 1, 'win32'), false);
  response.result.protocol_version = 2;
  assert.equal(isValidNativeHelperIdentity(response, 0, 'win32'), false);
});
