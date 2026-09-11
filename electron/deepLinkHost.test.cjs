'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldRegisterProtocolClient } = require('./deepLinkHost.cjs');

test('canonical packaged Abu may register the production protocol', () => {
  assert.equal(shouldRegisterProtocolClient({
    isPackaged: true,
  }, 'abu'), true);
});

test('isolated packaged products cannot replace the production protocol', () => {
  assert.equal(shouldRegisterProtocolClient({
    isPackaged: true,
  }, 'abu-computer-use-test'), false);
  assert.equal(shouldRegisterProtocolClient({ isPackaged: true }, ''), false);
});

test('unpackaged development keeps the separate abu-dev protocol', () => {
  assert.equal(shouldRegisterProtocolClient({ isPackaged: false }), true);
});
