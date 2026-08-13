'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  GUIDE_STRING_KEYS,
  sanitizeGuideStrings,
  normalizePermissions,
  derivePermissionGuideViewState,
  permissionsEqual,
  permissionWaitTimedOut,
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
      permissions: { screenRead: false, uiControl: false, restartRequired: false },
    }),
    {
      permissions: { screenRead: false, uiControl: false, restartRequired: false },
      requirements: { screenRead: true, uiControl: true },
      currentPermission: 'screenRead',
      requesting: null,
      error: null,
      restartRequired: false,
      complete: false,
    }
  );
  assert.deepEqual(
    derivePermissionGuideViewState({
      permissions: { screenRead: true, uiControl: false, restartRequired: false },
      requesting: 'uiControl',
    }),
    {
      permissions: { screenRead: true, uiControl: false, restartRequired: false },
      requirements: { screenRead: true, uiControl: true },
      currentPermission: 'uiControl',
      requesting: 'uiControl',
      error: null,
      restartRequired: false,
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

test('permission guide requests only the permissions required by the current task', () => {
  assert.deepEqual(
    derivePermissionGuideViewState({
      permissions: { screenRead: false, uiControl: false, restartRequired: false },
      requirements: { screenRead: false, uiControl: true },
    }),
    {
      permissions: { screenRead: false, uiControl: false, restartRequired: false },
      requirements: { screenRead: false, uiControl: true },
      currentPermission: 'uiControl',
      requesting: null,
      error: null,
      restartRequired: false,
      complete: false,
    }
  );
  assert.equal(
    derivePermissionGuideViewState({
      permissions: { screenRead: false, uiControl: true },
      requirements: { screenRead: false, uiControl: true },
    }).complete,
    true
  );
  assert.equal(
    derivePermissionGuideViewState({
      permissions: { screenRead: true, uiControl: false },
      requirements: { screenRead: true, uiControl: false },
    }).complete,
    true
  );
});

test('permission guide normalizes probe output and detects real status changes', () => {
  assert.deepEqual(normalizePermissions(null), {
    screenRead: false,
    uiControl: false,
    restartRequired: false,
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

test('permission guide exposes relaunch-required without marking setup complete', () => {
  const view = derivePermissionGuideViewState({
    permissions: {
      screenRead: false,
      uiControl: true,
      restartRequired: true,
    },
    requirements: { screenRead: false, uiControl: true },
  });
  assert.equal(view.restartRequired, true);
  assert.equal(view.currentPermission, null);
  assert.equal(view.complete, false);
});

test('permission guide polling has a deterministic 120-second boundary', () => {
  assert.equal(permissionWaitTimedOut(1_000, 120_999, 120_000), false);
  assert.equal(permissionWaitTimedOut(1_000, 121_000, 120_000), true);
  assert.equal(permissionWaitTimedOut(undefined, 121_000, 120_000), false);
});

test('native helper never owns GUI permission prompts', () => {
  assert.equal(HELPER_CMDS.has('request_accessibility'), false);
  assert.equal(HELPER_CMDS.has('request_screen_recording'), false);
});
