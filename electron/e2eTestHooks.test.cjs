'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readE2ETestHooks } = require('./e2eTestHooks.cjs');
const { createPayloadTooLargeError, payloadTooLargeMessage } = require('./ipcPayloadError.cjs');

const env = { ABU_E2E_MCP_WRITE_LIMIT_BYTES: '300000', ABU_E2E_SIDECAR_SPAWN_DELAY_MS: '70000' };

test('packaged builds ignore test hooks, even with ABU_PACKAGED_E2E=1', () => {
  assert.deepEqual(readE2ETestHooks({ env, isPackaged: true }), {});
  assert.deepEqual(readE2ETestHooks({ env: { ...env, ABU_PACKAGED_E2E: '1' }, isPackaged: true }), {});
  // Anything that is not literally `false` counts as packaged.
  assert.deepEqual(readE2ETestHooks({ env, isPackaged: undefined }), {});
});

test('dev builds honor only positive integer hooks', () => {
  assert.deepEqual(readE2ETestHooks({ env, isPackaged: false }), { mcpWriteLimitBytes: 300000, sidecarSpawnDelayMs: 70000 });
  assert.deepEqual(readE2ETestHooks({
    env: { ABU_E2E_MCP_WRITE_LIMIT_BYTES: '-1', ABU_E2E_SIDECAR_SPAWN_DELAY_MS: 'abc' },
    isPackaged: false,
  }), {});
  assert.deepEqual(readE2ETestHooks({
    env: { ABU_E2E_MCP_WRITE_LIMIT_BYTES: '0', ABU_E2E_SIDECAR_SPAWN_DELAY_MS: '1e3' },
    isPackaged: false,
  }), {});
  assert.deepEqual(readE2ETestHooks({ env: { ABU_E2E_MCP_WRITE_LIMIT_BYTES: '99999999999999999999' }, isPackaged: false }), {});
  assert.deepEqual(readE2ETestHooks({ env: {}, isPackaged: false }), {});
});

test('payload_too_large error carries typed fields in a stable message', () => {
  const err = createPayloadTooLargeError({ bytes: 9, limit: 8, method: 'mcp_write' });
  assert.equal(err.code, 'payload_too_large');
  assert.equal(err.bytes, 9);
  assert.equal(err.limit, 8);
  assert.equal(err.method, 'mcp_write');
  assert.equal(err.message, 'payload_too_large {"code":"payload_too_large","bytes":9,"limit":8,"method":"mcp_write"}');
  assert.equal(payloadTooLargeMessage({ bytes: 9, limit: 8, method: 'mcp_write' }), err.message);
});
