const COMMON_NATIVE_HELPER_COMMANDS = Object.freeze([
  'health',
  'mouse_click',
  'capture_screen',
]);

const MACOS_NATIVE_HELPER_COMMANDS = Object.freeze([
  'frontmost_app_identity',
  'ax_snapshot',
]);

export function requiredNativeHelperCommands(platform) {
  return platform === 'darwin'
    ? [...COMMON_NATIVE_HELPER_COMMANDS, ...MACOS_NATIVE_HELPER_COMMANDS]
    : [...COMMON_NATIVE_HELPER_COMMANDS];
}

export function isValidNativeHelperIdentity(response, status, platform) {
  const identity = response?.result;
  return status === 0 &&
    response?.id === 1 &&
    identity?.protocol_version === 1 &&
    typeof identity?.binary_version === 'string' &&
    identity.binary_version.length > 0 &&
    typeof identity?.platform === 'string' &&
    typeof identity?.started_at_ms === 'number' &&
    Array.isArray(identity?.supported_commands) &&
    requiredNativeHelperCommands(platform).every((command) =>
      identity.supported_commands.includes(command),
    );
}
