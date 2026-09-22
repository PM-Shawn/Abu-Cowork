const COMMON_NATIVE_HELPER_COMMANDS = Object.freeze([
  'health',
  'mouse_click',
  'capture_screen',
]);

const WINDOWS_NATIVE_HELPER_COMMANDS = Object.freeze([
  'list_windows',
  'ax_snapshot',
  'mouse_drag',
]);

const MACOS_NATIVE_HELPER_COMMANDS = Object.freeze([
  'frontmost_app_identity',
  'ax_snapshot',
]);

export function requiredNativeHelperCommands(platform) {
  if (platform === 'darwin') {
    return [...COMMON_NATIVE_HELPER_COMMANDS, ...MACOS_NATIVE_HELPER_COMMANDS];
  }
  if (platform === 'win32') {
    return [...COMMON_NATIVE_HELPER_COMMANDS, ...WINDOWS_NATIVE_HELPER_COMMANDS];
  }
  return [...COMMON_NATIVE_HELPER_COMMANDS];
}

export function isValidNativeHelperIdentity(response, status, platform) {
  const identity = response?.result;
  return status === 0 &&
    response?.id === 1 &&
    identity?.protocol_version === 2 &&
    typeof identity?.binary_version === 'string' &&
    identity.binary_version.length > 0 &&
    typeof identity?.platform === 'string' &&
    typeof identity?.started_at_ms === 'number' &&
    Array.isArray(identity?.supported_commands) &&
    identity?.capabilities?.transport === 'ndjson-stdio' &&
    identity?.capabilities?.request_serialization === 'host' &&
    (platform !== 'win32' || (
      identity.capabilities.accessibility === 'windows-uia' &&
      identity.capabilities.screen_capture === 'wgc-monitor' &&
      identity.capabilities.input === 'sendinput-guarded' &&
      identity.capabilities.physical_input_monitoring === true
    )) &&
    requiredNativeHelperCommands(platform).every((command) =>
      identity.supported_commands.includes(command),
    );
}
