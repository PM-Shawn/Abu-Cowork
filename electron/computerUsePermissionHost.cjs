'use strict';

const COMPUTER_USE_PERMISSION_HOST_MISS =
  Symbol('computer-use-permission-host-miss');

const PERMISSION_COMMANDS = new Set([
  'check_macos_permissions',
  'request_screen_recording',
  'request_accessibility',
]);

const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

function createComputerUsePermissionHost({
  platform = process.platform,
  electronProvider = () => require('electron'),
} = {}) {
  let accessibilityRequested = false;
  let screenRecordingRequested = false;

  function screenStatus(status) {
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    if (status === 'restricted') return 'restricted';
    if (status === 'not-determined') {
      return screenRecordingRequested ? 'pending-user-action' : 'not-determined';
    }
    return 'unavailable';
  }

  async function probeScreenRecording(desktopCapturer) {
    try {
      await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      });
      return true;
    } catch {
      return false;
    }
  }

  return async function computerUsePermissionHostDispatch(cmd) {
    if (!PERMISSION_COMMANDS.has(cmd)) {
      return COMPUTER_USE_PERMISSION_HOST_MISS;
    }
    if (platform !== 'darwin') {
      return cmd === 'check_macos_permissions'
        ? COMPUTER_USE_PERMISSION_HOST_MISS
        : true;
    }

    const { desktopCapturer, shell, systemPreferences } = electronProvider();
    if (cmd === 'check_macos_permissions') {
      const rawScreenStatus = systemPreferences.getMediaAccessStatus('screen');
      const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
      const screenProbe = rawScreenStatus === 'granted'
        ? await probeScreenRecording(desktopCapturer)
        : false;
      const screenRecordingStatus = rawScreenStatus === 'granted' && !screenProbe
        ? 'granted-relaunch-required'
        : screenStatus(rawScreenStatus);
      const accessibilityStatus = accessibility
        ? 'granted'
        : (accessibilityRequested ? 'pending-user-action' : 'not-determined');
      return {
        screen_recording: screenRecordingStatus === 'granted',
        accessibility: accessibilityStatus === 'granted',
        screen_recording_status: screenRecordingStatus,
        accessibility_status: accessibilityStatus,
        restart_required: screenRecordingStatus === 'granted-relaunch-required',
      };
    }
    if (cmd === 'request_accessibility') {
      accessibilityRequested = true;
      return systemPreferences.isTrustedAccessibilityClient(true);
    }

    const status = systemPreferences.getMediaAccessStatus('screen');
    screenRecordingRequested = true;
    if (status === 'granted') return probeScreenRecording(desktopCapturer);
    if (status === 'denied' || status === 'restricted') {
      await shell.openExternal(SCREEN_RECORDING_SETTINGS_URL);
      return false;
    }

    // Keep the macOS consent request owned by the GUI app, not the CLI helper.
    await probeScreenRecording(desktopCapturer);
    return systemPreferences.getMediaAccessStatus('screen') === 'granted';
  };
}

const computerUsePermissionHostDispatch = createComputerUsePermissionHost();

module.exports = {
  COMPUTER_USE_PERMISSION_HOST_MISS,
  SCREEN_RECORDING_SETTINGS_URL,
  createComputerUsePermissionHost,
  computerUsePermissionHostDispatch,
};
