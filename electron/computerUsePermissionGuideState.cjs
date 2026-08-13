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
  'timeout',
  'restart',
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
  const screenReadStatus = typeof permissions.screenReadStatus === 'string'
    ? permissions.screenReadStatus
    : typeof permissions.screen_recording_status === 'string'
      ? permissions.screen_recording_status
      : null;
  const uiControlStatus = typeof permissions.uiControlStatus === 'string'
    ? permissions.uiControlStatus
    : typeof permissions.accessibility_status === 'string'
      ? permissions.accessibility_status
      : null;
  return {
    screenRead: permissions.screenRead === true,
    uiControl: permissions.uiControl === true,
    restartRequired: permissions.restartRequired === true
      || permissions.restart_required === true
      || screenReadStatus === 'granted-relaunch-required'
      || uiControlStatus === 'granted-relaunch-required',
  };
}

function normalizeRequirements(value) {
  if (!isPlainObject(value)) {
    return { screenRead: true, uiControl: true };
  }
  return {
    screenRead: value.screenRead === true,
    uiControl: value.uiControl === true,
  };
}

function requiredPermissionsReady(permissions, requirements) {
  const normalizedPermissions = normalizePermissions(permissions);
  const normalizedRequirements = normalizeRequirements(requirements);
  return !normalizedPermissions.restartRequired && (
    (!normalizedRequirements.screenRead || normalizedPermissions.screenRead)
    && (!normalizedRequirements.uiControl || normalizedPermissions.uiControl)
  );
}

function derivePermissionGuideViewState({
  permissions,
  requirements,
  requesting = null,
  error = null,
  complete = false,
}) {
  const normalized = normalizePermissions(permissions);
  const required = normalizeRequirements(requirements);
  const currentPermission = normalized.restartRequired
    ? null
    : required.screenRead && !normalized.screenRead
      ? 'screenRead'
      : required.uiControl && !normalized.uiControl
        ? 'uiControl'
        : null;
  const safeRequesting = requesting === currentPermission ? requesting : null;

  return {
    permissions: normalized,
    requirements: required,
    currentPermission,
    requesting: safeRequesting,
    error: typeof error === 'string' && error.length > 0
      ? error.slice(0, MAX_GUIDE_STRING_LENGTH)
      : null,
    restartRequired: normalized.restartRequired,
    complete: !normalized.restartRequired && (complete || currentPermission === null),
  };
}

function permissionsEqual(left, right) {
  return (
    left?.screenRead === right?.screenRead
    && left?.uiControl === right?.uiControl
    && left?.restartRequired === right?.restartRequired
  );
}

function permissionWaitTimedOut(startedAt, currentTime, timeoutMs) {
  return (
    Number.isFinite(startedAt)
    && Number.isFinite(currentTime)
    && Number.isFinite(timeoutMs)
    && timeoutMs >= 0
    && currentTime - startedAt >= timeoutMs
  );
}

module.exports = {
  GUIDE_STRING_KEYS,
  sanitizeGuideStrings,
  normalizePermissions,
  normalizeRequirements,
  requiredPermissionsReady,
  derivePermissionGuideViewState,
  permissionsEqual,
  permissionWaitTimedOut,
};
