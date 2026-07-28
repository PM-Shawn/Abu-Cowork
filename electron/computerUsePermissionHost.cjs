'use strict';

const COMPUTER_USE_PERMISSION_HOST_MISS =
  Symbol('computer-use-permission-host-miss');

const PERMISSION_COMMANDS = new Set([
  'request_screen_recording',
  'request_accessibility',
]);

const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

function createComputerUsePermissionHost({
  platform = process.platform,
  electronProvider = () => require('electron'),
} = {}) {
  return async function computerUsePermissionHostDispatch(cmd) {
    if (!PERMISSION_COMMANDS.has(cmd)) {
      return COMPUTER_USE_PERMISSION_HOST_MISS;
    }
    if (platform !== 'darwin') return true;

    const { desktopCapturer, shell, systemPreferences } = electronProvider();
    if (cmd === 'request_accessibility') {
      return systemPreferences.isTrustedAccessibilityClient(true);
    }

    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status === 'granted') return true;
    if (status === 'denied' || status === 'restricted') {
      await shell.openExternal(SCREEN_RECORDING_SETTINGS_URL);
      return false;
    }

    // Keep the macOS consent request owned by the GUI app, not the CLI helper.
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
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
