'use strict';

/**
 * Microphone access for voice input.
 *
 * Only the main window's registered page may capture audio. Chromium asks the
 * default session's permission handlers; without handlers Electron grants every
 * request, so this module installs them and narrows `media` to audio-only
 * requests from the main frame of the trusted page. Every other permission keeps
 * Electron's default (granted) so installing these handlers changes nothing
 * outside the microphone.
 *
 * On macOS the OS consent (TCC) sits behind Chromium's: the request handler
 * asks `systemPreferences.askForMediaAccess('microphone')`, which only prompts
 * when the signed app carries `com.apple.security.device.audio-input`
 * (build/entitlements.mac.plist) and `NSMicrophoneUsageDescription`
 * (electron-builder.yml `mac.extendInfo`).
 */

const MICROPHONE_CHANNEL = 'abu:microphone';
const MACOS_MICROPHONE_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
const WINDOWS_MICROPHONE_SETTINGS_URL = 'ms-settings:privacy-microphone';

const MICROPHONE_STATUSES = new Set(['not-determined', 'granted', 'denied', 'restricted', 'unknown']);

/**
 * @param {string} platform
 * @param {{ getMediaAccessStatus?: (type: 'microphone') => string } | undefined} systemPreferences
 * @returns {'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'}
 */
function readMicrophoneStatus(platform, systemPreferences) {
  // Linux has no OS-level consent Electron can read; Chromium's own handler decides.
  if (platform !== 'darwin' && platform !== 'win32') return 'granted';
  if (!systemPreferences || typeof systemPreferences.getMediaAccessStatus !== 'function') return 'unknown';
  const status = systemPreferences.getMediaAccessStatus('microphone');
  return MICROPHONE_STATUSES.has(status) ? status : 'unknown';
}

/**
 * @param {unknown} details
 * @param {object | null | undefined} webContents
 */
function requestingUrlOf(details, webContents) {
  const url = details && typeof details === 'object' ? details.requestingUrl : undefined;
  if (typeof url === 'string' && url) return url;
  return webContents && typeof webContents.getURL === 'function' ? webContents.getURL() : '';
}

/**
 * Install the default session's permission handlers.
 *
 * @param {{
 *   setPermissionCheckHandler: (handler: Function) => void,
 *   setPermissionRequestHandler: (handler: Function) => void,
 * }} session
 * @param {{
 *   platform: string,
 *   systemPreferences?: {
 *     getMediaAccessStatus?: (type: 'microphone') => string,
 *     askForMediaAccess?: (type: 'microphone') => Promise<boolean>,
 *   },
 *   isTrustedMainWindowPage: (webContents: object | null | undefined, url: string) => boolean,
 * }} deps
 */
function installMicrophonePermissions(session, deps) {
  const { platform, systemPreferences, isTrustedMainWindowPage } = deps;

  session.setPermissionCheckHandler((webContents, permission, _origin, details = {}) => {
    if (permission !== 'media') return true;
    if (details.mediaType !== 'audio' || details.isMainFrame !== true) return false;
    if (!isTrustedMainWindowPage(webContents, requestingUrlOf(details, webContents))) return false;
    return readMicrophoneStatus(platform, systemPreferences) === 'granted';
  });

  session.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    if (permission !== 'media') {
      callback(true);
      return;
    }
    const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const audioOnly = mediaTypes.length === 1 && mediaTypes[0] === 'audio';
    if (!audioOnly || details.isMainFrame !== true
      || !isTrustedMainWindowPage(webContents, requestingUrlOf(details, webContents))) {
      callback(false);
      return;
    }
    if (platform !== 'darwin') {
      // Windows enforces its privacy switch inside the capture stack; getUserMedia
      // then rejects with NotAllowedError, which the renderer maps to guidance.
      callback(true);
      return;
    }
    if (!systemPreferences || typeof systemPreferences.askForMediaAccess !== 'function') {
      callback(false);
      return;
    }
    Promise.resolve()
      .then(() => systemPreferences.askForMediaAccess('microphone'))
      .then((granted) => callback(granted === true), () => callback(false));
  });
}

/**
 * Renderer-facing status/settings actions behind `abu:microphone`.
 *
 * @param {{
 *   platform: string,
 *   systemPreferences?: { getMediaAccessStatus?: (type: 'microphone') => string },
 *   openExternal: (url: string) => Promise<unknown> | unknown,
 * }} deps
 */
function createMicrophoneHost(deps) {
  const { platform, systemPreferences, openExternal } = deps;
  return async function dispatchMicrophone(action) {
    switch (action) {
      case 'status':
        return readMicrophoneStatus(platform, systemPreferences);
      case 'open-settings': {
        const url = platform === 'darwin'
          ? MACOS_MICROPHONE_SETTINGS_URL
          : platform === 'win32' ? WINDOWS_MICROPHONE_SETTINGS_URL : null;
        if (!url) return false;
        await openExternal(url);
        return true;
      }
      default:
        throw new Error('Microphone: unsupported action');
    }
  };
}

module.exports = {
  MICROPHONE_CHANNEL,
  MACOS_MICROPHONE_SETTINGS_URL,
  WINDOWS_MICROPHONE_SETTINGS_URL,
  createMicrophoneHost,
  installMicrophonePermissions,
  readMicrophoneStatus,
};
