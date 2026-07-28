'use strict';

const GUIDE_STRING_KEYS = [
  'title',
  'description',
  'screenTitle',
  'screenDescription',
  'controlTitle',
  'controlDescription',
  'screenStep',
  'controlStep',
  'allow',
  'done',
  'checking',
  'cancel',
  'returnToAbu',
  'missingApp',
  'revealApp',
  'developmentIdentity',
  'errorTitle',
  'retry',
  'privacyNote',
];

const MAX_GUIDE_STRING_LENGTH = 600;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeGuideStrings(value) {
  if (!isPlainObject(value)) {
    throw new Error('Computer Use permission guide strings must be an object');
  }
  const result = {};
  for (const key of GUIDE_STRING_KEYS) {
    const text = value[key];
    if (
      typeof text !== 'string'
      || text.trim().length === 0
      || text.length > MAX_GUIDE_STRING_LENGTH
    ) {
      throw new Error(`Computer Use permission guide string '${key}' is invalid`);
    }
    result[key] = text;
  }
  return result;
}

function normalizePermissions(value) {
  const permissions = isPlainObject(value) ? value : {};
  return {
    screenRead: permissions.screenRead === true,
    uiControl: permissions.uiControl === true,
  };
}

function derivePermissionGuideViewState({
  permissions,
  requesting = null,
  error = null,
  complete = false,
}) {
  const normalized = normalizePermissions(permissions);
  const currentPermission = !normalized.screenRead
    ? 'screenRead'
    : !normalized.uiControl
      ? 'uiControl'
      : null;
  const safeRequesting = requesting === currentPermission ? requesting : null;

  return {
    permissions: normalized,
    currentPermission,
    requesting: safeRequesting,
    error: typeof error === 'string' && error.length > 0
      ? error.slice(0, MAX_GUIDE_STRING_LENGTH)
      : null,
    complete: complete || currentPermission === null,
  };
}

function permissionsEqual(left, right) {
  return (
    left?.screenRead === right?.screenRead
    && left?.uiControl === right?.uiControl
  );
}

module.exports = {
  GUIDE_STRING_KEYS,
  sanitizeGuideStrings,
  normalizePermissions,
  derivePermissionGuideViewState,
  permissionsEqual,
};
