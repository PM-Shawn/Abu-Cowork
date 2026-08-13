/**
 * Computer Use permission status helpers.
 *
 * On macOS, capturing the screen requires "Screen Recording" permission.
 * On Windows, it usually works without extra permissions.
 *
 * Permission checks must remain non-privileged probes. A real screenshot is a
 * protected Computer Use action and requires a task-scoped main-process token.
 */

import { invoke } from '@tauri-apps/api/core';
import { dirname, executableDir } from '@tauri-apps/api/path';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { isMacOS } from '@/utils/platform';
import { hasElectronCommandHost } from '@/utils/electronHost';

export interface ComputerUsePermissions {
  screenRead: boolean;
  uiControl: boolean;
  screenReadStatus: ComputerUsePermissionStatus;
  uiControlStatus: ComputerUsePermissionStatus;
  restartRequired: boolean;
}

export type ComputerUsePermission = 'screenRead' | 'uiControl';
export type ComputerUsePermissionStatus =
  | 'not-determined'
  | 'requesting'
  | 'pending-user-action'
  | 'granted'
  | 'granted-relaunch-required'
  | 'denied'
  | 'restricted'
  | 'unavailable';

export type ComputerUseExecutionPath = 'ax' | 'screen-read' | 'pixel-control';

export interface ComputerUsePermissionRequirements {
  screenRead: boolean;
  uiControl: boolean;
}

interface RawComputerUsePermissions {
  screen_recording: boolean;
  accessibility: boolean;
  screen_recording_status?: ComputerUsePermissionStatus;
  accessibility_status?: ComputerUsePermissionStatus;
  restart_required?: boolean;
}

export function requiredComputerUsePermissions(path: ComputerUseExecutionPath): {
  screenRead: boolean;
  uiControl: boolean;
} {
  return {
    screenRead: path !== 'ax',
    uiControl: path !== 'screen-read',
  };
}

function permissionStatus(
  value: ComputerUsePermissionStatus | undefined,
  granted: boolean,
): ComputerUsePermissionStatus {
  return value ?? (granted ? 'granted' : 'not-determined');
}

export function normalizeComputerUsePermissions(
  raw: RawComputerUsePermissions,
): ComputerUsePermissions {
  const screenReadStatus = permissionStatus(
    raw.screen_recording_status,
    raw.screen_recording,
  );
  const uiControlStatus = permissionStatus(
    raw.accessibility_status,
    raw.accessibility,
  );
  return {
    screenRead: screenReadStatus === 'granted',
    uiControl: uiControlStatus === 'granted',
    screenReadStatus,
    uiControlStatus,
    restartRequired: raw.restart_required === true
      || screenReadStatus === 'granted-relaunch-required'
      || uiControlStatus === 'granted-relaunch-required',
  };
}

export interface ComputerUsePermissionGuideStrings {
  title: string;
  description: string;
  screenTitle: string;
  screenDescription: string;
  controlTitle: string;
  controlDescription: string;
  screenStep: string;
  controlStep: string;
  allow: string;
  done: string;
  checking: string;
  cancel: string;
  returnToAbu: string;
  missingApp: string;
  revealApp: string;
  developmentIdentity: string;
  errorTitle: string;
  retry: string;
  timeout: string;
  restart: string;
  privacyNote: string;
}

export interface ComputerUsePermissionGuideResult {
  status: 'complete' | 'relaunch-required' | 'cancelled' | 'unavailable';
  permissions: ComputerUsePermissions;
  error: string | null;
}

const MACOS_PERMISSION_URLS: Record<ComputerUsePermission, string> = {
  screenRead:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  uiControl:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

/**
 * Test if we have permission to capture the screen.
 * Returns true if the screenshot succeeds, false if denied.
 */
export async function testScreenshotPermission(): Promise<boolean> {
  try {
    const permissions = await invoke<{
      screen_recording: boolean;
      accessibility: boolean;
    }>('check_macos_permissions');
    return permissions.screen_recording;
  } catch {
    return false;
  }
}

/**
 * Read the two independent permissions used by Computer Use.
 *
 * This is a non-prompting status probe. The existing tool executor remains
 * responsible for requesting/opening OS settings when an action needs a
 * permission that is missing.
 */
export async function checkComputerUsePermissions(): Promise<ComputerUsePermissions | undefined> {
  try {
    const permissions = await invoke<RawComputerUsePermissions>('check_macos_permissions');
    return normalizeComputerUsePermissions(permissions);
  } catch {
    return undefined;
  }
}

/**
 * Start the user-facing permission flow. Screen capture gets the native macOS
 * prompt first; both permissions then fall back to their exact Settings pane.
 * Other platforms keep their existing status-only behavior.
 */
export async function requestComputerUsePermission(
  permission: ComputerUsePermission,
): Promise<boolean> {
  if (permission === 'screenRead') {
    try {
      const granted = await invoke<boolean>('request_screen_recording');
      if (granted) return true;
    } catch {
      // The status probe below remains authoritative.
    }
  }

  if (permission === 'uiControl' && hasElectronCommandHost()) {
    try {
      const granted = await invoke<boolean>('request_accessibility');
      if (granted) return true;
    } catch {
      // Opening the exact Settings pane below remains the fallback.
    }
  }

  const current = await checkComputerUsePermissions();
  if (current?.[permission]) return true;
  if (!isMacOS()) return false;

  await openUrl(MACOS_PERMISSION_URLS[permission]);
  return false;
}

/**
 * Run Electron's always-on-top permission coach. The main process owns its
 * native permission polling so the guide remains stable while System Settings
 * is foreground. Tauri keeps its existing in-window setup flow.
 */
export async function runComputerUsePermissionGuide({
  requestedByTask,
  permissions,
  requirements,
  strings,
}: {
  requestedByTask: boolean;
  permissions?: ComputerUsePermissions;
  requirements?: ComputerUsePermissionRequirements;
  strings: ComputerUsePermissionGuideStrings;
}): Promise<ComputerUsePermissionGuideResult | undefined> {
  if (!isMacOS() || !hasElectronCommandHost()) return undefined;
  return invoke<ComputerUsePermissionGuideResult>(
    'computer_use_permission_guide_show',
    {
      requestedByTask,
      permissions,
      ...(requirements ? { requirements } : {}),
      strings,
    },
  );
}

export async function closeComputerUsePermissionGuide(): Promise<void> {
  if (!isMacOS() || !hasElectronCommandHost()) return;
  await invoke('computer_use_permission_guide_close');
}

/**
 * Reveal the current macOS app bundle for the TCC fallback flow.
 *
 * Both packaged Tauri and Electron apps place their executable under
 * `<App>.app/Contents/MacOS`. In Electron development this intentionally
 * reveals Electron.app, which is the process macOS associates with the dev
 * session's permissions.
 */
export async function revealComputerUseAppInFinder(): Promise<boolean> {
  if (!isMacOS()) return false;

  const executableDirectory = await executableDir();
  const contentsDirectory = await dirname(executableDirectory);
  const appBundlePath = await dirname(contentsDirectory);
  if (!appBundlePath.toLowerCase().endsWith('.app')) return false;

  await revealItemInDir(appBundlePath);
  return true;
}
