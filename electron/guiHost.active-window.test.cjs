'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { guiDispatch } = require('./guiHost.cjs');

test(
  'native active-window probe returns the complete identity required by the Computer Use gate',
  { skip: !['darwin', 'win32'].includes(process.platform) },
  async () => {
    const identity = await guiDispatch(null, 'get_active_window', {});

    assert.equal(typeof identity.app_name, 'string');
    assert.ok(identity.app_name.trim().length > 0);
    assert.equal(typeof identity.bundle_id, 'string');
    assert.ok(identity.bundle_id.trim().length > 0);
    assert.ok(Number.isInteger(identity.process_id));
    assert.ok(identity.process_id > 0);
  }
);
