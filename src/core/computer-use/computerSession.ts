import { invoke } from '@tauri-apps/api/core';
import { hasElectronCommandHost } from '@/utils/electronHost';

const OBSERVATION_COMMANDS = ['capture_screen', 'capture_screen_excluding', 'ax_snapshot'] as const;
const ACTION_COMMANDS = [
  'activate_app', 'mouse_click', 'mouse_move', 'mouse_scroll', 'mouse_drag',
  'keyboard_type', 'keyboard_press', 'ax_press', 'ax_set_value', 'ax_replace_text', 'ax_perform_action',
] as const;
export type ComputerObservationCommand = typeof OBSERVATION_COMMANDS[number];
export type ComputerActionCommand = typeof ACTION_COMMANDS[number];
export type ComputerUseCommand = ComputerObservationCommand | ComputerActionCommand;
const SESSION_COMMANDS: ReadonlySet<string> = new Set([...OBSERVATION_COMMANDS, ...ACTION_COMMANDS]);

export const COMPUTER_USE_TOKEN_ARG = '__abuComputerUseToken';

export interface ComputerUseInvocation {
  token: string | null;
  abortSignal: AbortSignal | null;
}

export function computerUseAbortError(): DOMException {
  return new DOMException('Computer Use was stopped', 'AbortError');
}

export function assertComputerUseNotAborted(signal: AbortSignal | null = null): void {
  if (signal?.aborted) throw computerUseAbortError();
}

/** Internal session transport, not a model tool. Observations (including refresh)
 * and actions share cancellation/token enforcement. Command groups are NOT
 * permission grants: the immutable Host Gate validates token scope and limits.
 * Never retry here: a transport failure may conceal a completed side effect.
 */
export async function invokeComputerUse<T>(
  invocation: ComputerUseInvocation,
  command: ComputerUseCommand,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!SESSION_COMMANDS.has(command)) throw new Error('Unsupported Computer Use command');
  const electron = hasElectronCommandHost();
  if (electron && !invocation.token) throw new Error('Computer Use session is not authorized');
  assertComputerUseNotAborted(invocation.abortSignal);
  // The Tauri-shaped API routes through Electron preload -> Host Gate in the
  // current shell. Keep the shipped legacy transport payload unchanged.
  const result = await invoke<T>(command, electron
    ? { ...args, [COMPUTER_USE_TOKEN_ARG]: invocation.token }
    : args);
  assertComputerUseNotAborted(invocation.abortSignal);
  return result;
}
