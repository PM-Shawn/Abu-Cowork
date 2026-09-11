'use strict';

const COMPUTER_USE_TOKEN_ARG = '__abuComputerUseToken';
const COMPUTER_USE_REQUEST_CONTEXT_ARG = '__abuComputerUseRequestContext';

const COMPUTER_USE_PROBE_COMMANDS = new Set([
  'native_helper_health',
  'check_macos_permissions',
  'request_screen_recording',
  'request_accessibility',
  'resolve_app_identity',
  'frontmost_app_identity',
]);

const COMPUTER_USE_CLEANUP_COMMANDS = new Set([
  'ax_close_session',
]);

const COMPUTER_USE_READ_COMMANDS = new Set([
  'capture_screen',
  'capture_screen_excluding',
  'ax_snapshot',
]);

const COMPUTER_USE_CONTROL_COMMANDS = new Set([
  'activate_app',
  'mouse_click',
  'mouse_move',
  'mouse_scroll',
  'mouse_drag',
  'keyboard_type',
  'keyboard_press',
  'ax_press',
  'ax_set_value',
  'ax_replace_text',
  'ax_perform_action',
]);

const COMPUTER_USE_PRIVILEGED_COMMANDS = new Set([
  ...COMPUTER_USE_READ_COMMANDS,
  ...COMPUTER_USE_CONTROL_COMMANDS,
]);

const COMPUTER_USE_HOST_COMMANDS = new Set([
  'computer_use_set_enabled',
  'computer_use_capture_turn_target',
  'computer_use_list_windows',
  'computer_use_begin_session',
  'computer_use_end_session',
  'computer_use_end_task',
  'computer_use_stop_turn',
  'computer_use_get_task_status',
]);

module.exports = {
  COMPUTER_USE_TOKEN_ARG,
  COMPUTER_USE_REQUEST_CONTEXT_ARG,
  COMPUTER_USE_PROBE_COMMANDS,
  COMPUTER_USE_CLEANUP_COMMANDS,
  COMPUTER_USE_READ_COMMANDS,
  COMPUTER_USE_CONTROL_COMMANDS,
  COMPUTER_USE_PRIVILEGED_COMMANDS,
  COMPUTER_USE_HOST_COMMANDS,
};
