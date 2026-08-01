'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  GUIDE_STRING_KEYS,
  sanitizeGuideStrings,
  normalizePermissions,
  derivePermissionGuideViewState,
  permissionsEqual,
} = require('./computerUsePermissionGuideState.cjs');
const { HELPER_CMDS } = require('./nativeHelperManager.cjs');

function validStrings() {
  return Object.fromEntries(GUIDE_STRING_KEYS.map((key) => [key, key]));
}

test('permission guide validates its complete localized string contract', () => {
  assert.deepEqual(sanitizeGuideStrings(validStrings()), validStrings());
  assert.throws(
    () => sanitizeGuideStrings({ ...validStrings(), allow: '' }),
    /string 'allow' is invalid/
  );
  assert.throws(
    () => sanitizeGuideStrings({ ...validStrings(), retry: 'x'.repeat(601) }),
    /string 'retry' is invalid/
  );
});

test('permission guide advances one permission at a time without recreating state', () => {
  assert.deepEqual(
    derivePermissionGuideViewState({
      permissions: { screenRead: false, uiControl: false },
    }),
    {
      permissions: { screenRead: false, uiControl: false },
      currentPermission: 'screenRead',
      requesting: null,
      error: null,
      complete: false,
    }
  );
  assert.deepEqual(
    derivePermissionGuideViewState({
      permissions: { screenRead: true, uiControl: false },
      requesting: 'uiControl',
    }),
    {
      permissions: { screenRead: true, uiControl: false },
      currentPermission: 'uiControl',
      requesting: 'uiControl',
      error: null,
      complete: false,
    }
  );
  assert.equal(
    derivePermissionGuideViewState({
      permissions: { screenRead: true, uiControl: true },
    }).complete,
    true
  );
});

test('permission guide normalizes probe output and detects real status changes', () => {
  assert.deepEqual(normalizePermissions(null), {
    screenRead: false,
    uiControl: false,
  });
  assert.equal(
    permissionsEqual(
      { screenRead: true, uiControl: false },
      { screenRead: true, uiControl: false }
    ),
    true
  );
  assert.equal(
    permissionsEqual(
      { screenRead: true, uiControl: false },
      { screenRead: true, uiControl: true }
    ),
    false
  );
});

test('native helper never owns GUI permission prompts', () => {
  assert.equal(HELPER_CMDS.has('request_accessibility'), false);
  assert.equal(HELPER_CMDS.has('request_screen_recording'), false);
});
