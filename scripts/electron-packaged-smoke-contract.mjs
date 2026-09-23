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

/** How far the packaged Windows drag check moves the window, in DIP. */
export const WINDOWS_DRAG_DELTA = Object.freeze({ x: 48, y: 32 });

/** Gap left between the work area edge and the window before it is dragged. */
const WINDOWS_DRAG_MARGIN = 16;

/**
 * Where the packaged window has to sit for the Windows title-bar drag check.
 *
 * The helper asserts every drag coordinate against a window-scoped screenshot,
 * which is the window rectangle cropped to the monitor. Both ends of the drag
 * therefore have to land inside the window, and the window has to be inside
 * the display for that to be possible. A window larger than the work area is
 * centred at a negative origin, which puts the title-bar lane above the top of
 * the screen; the smoke's own display on CI is 1024x728, small enough for the
 * 1200x800 packaged window to land there.
 *
 * Returns the current bounds unchanged when the window already sits inside the
 * work area with room for the drag, and otherwise the bounds to move it to.
 */
export function planWindowsDragFit(bounds, workArea) {
  const roomRight = workArea.x + workArea.width - (bounds.x + bounds.width);
  const roomDown = workArea.y + workArea.height - (bounds.y + bounds.height);
  const fits = bounds.x >= workArea.x
    && bounds.y >= workArea.y
    && roomRight >= WINDOWS_DRAG_DELTA.x
    && roomDown >= WINDOWS_DRAG_DELTA.y;
  if (fits) {
    return { fits: true, bounds: { ...bounds } };
  }
  return {
    fits: false,
    bounds: {
      x: workArea.x + WINDOWS_DRAG_MARGIN,
      y: workArea.y + WINDOWS_DRAG_MARGIN,
      width: Math.min(
        bounds.width,
        workArea.width - WINDOWS_DRAG_MARGIN - WINDOWS_DRAG_DELTA.x,
      ),
      height: Math.min(
        bounds.height,
        workArea.height - WINDOWS_DRAG_MARGIN - WINDOWS_DRAG_DELTA.y,
      ),
    },
  };
}

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
