import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkComputerUsePermissions,
  closeComputerUsePermissionGuide,
  requestComputerUsePermission,
  runComputerUsePermissionGuide,
  testScreenshotPermission,
  type ComputerUsePermissionGuideStrings,
} from './computerUsePermission';

const invoke = vi.fn();
const openUrl = vi.fn();
const revealItemInDir = vi.fn();
const executableDir = vi.fn();
const dirname = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock('@tauri-apps/api/path', () => ({
  executableDir: (...args: unknown[]) => executableDir(...args),
  dirname: (...args: unknown[]) => dirname(...args),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
  revealItemInDir: (...args: unknown[]) => revealItemInDir(...args),
}));
vi.mock('@/utils/platform', () => ({
  isMacOS: () => true,
}));

describe('Computer Use permission probes', () => {
  beforeEach(() => {
    invoke.mockReset();
    openUrl.mockReset();
    revealItemInDir.mockReset();
    executableDir.mockReset();
    dirname.mockReset();
    delete (globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar: boolean };
    }).__ABU_SHELL__;
  });

  it('keeps screen-read and UI-control permissions separate', async () => {
    invoke.mockResolvedValue({
      screen_recording: true,
      accessibility: false,
    });

    await expect(checkComputerUsePermissions()).resolves.toEqual({
      screenRead: true,
      uiControl: false,
    });
    expect(invoke).toHaveBeenCalledWith('check_macos_permissions');
  });

  it('returns undefined when the permission host is unavailable', async () => {
    invoke.mockRejectedValue(new Error('command unavailable'));

    await expect(checkComputerUsePermissions()).resolves.toBeUndefined();
  });

  it('checks screenshot permission without taking an unauthorized screenshot', async () => {
    invoke.mockResolvedValue({ screen_recording: true, accessibility: false });
    await expect(testScreenshotPermission()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('check_macos_permissions');

    invoke.mockRejectedValue(new Error('permission denied'));
    await expect(testScreenshotPermission()).resolves.toBe(false);
  });

  it('requests screen recording before opening the exact macOS settings pane', async () => {
    invoke
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({
        screen_recording: false,
        accessibility: false,
      });
    openUrl.mockResolvedValue(undefined);

    await expect(requestComputerUsePermission('screenRead')).resolves.toBe(false);
    expect(invoke).toHaveBeenNthCalledWith(1, 'request_screen_recording');
    expect(invoke).toHaveBeenNthCalledWith(2, 'check_macos_permissions');
    expect(openUrl).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  });

  it('opens Accessibility settings without requesting screen recording', async () => {
    invoke.mockResolvedValue({
      screen_recording: true,
      accessibility: false,
    });
    openUrl.mockResolvedValue(undefined);

    await expect(requestComputerUsePermission('uiControl')).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('check_macos_permissions');
    expect(openUrl).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
  });

  it('does not open settings when the permission is already granted', async () => {
    invoke.mockResolvedValue({
      screen_recording: true,
      accessibility: true,
    });

    await expect(requestComputerUsePermission('uiControl')).resolves.toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('reveals the current macOS app bundle for permission setup fallback', async () => {
    const { revealComputerUseAppInFinder } = await import('./computerUsePermission');
    executableDir.mockResolvedValue('/Applications/Abu.app/Contents/MacOS');
    dirname
      .mockResolvedValueOnce('/Applications/Abu.app/Contents')
      .mockResolvedValueOnce('/Applications/Abu.app');
    revealItemInDir.mockResolvedValue(undefined);

    await expect(revealComputerUseAppInFinder()).resolves.toBe(true);
    expect(revealItemInDir).toHaveBeenCalledWith('/Applications/Abu.app');
  });

  it('does not reveal an unrelated executable directory', async () => {
    const { revealComputerUseAppInFinder } = await import('./computerUsePermission');
    executableDir.mockResolvedValue('/usr/local/bin');
    dirname
      .mockResolvedValueOnce('/usr/local')
      .mockResolvedValueOnce('/usr');

    await expect(revealComputerUseAppInFinder()).resolves.toBe(false);
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it('delegates Electron onboarding to the main-owned floating guide', async () => {
    (globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar: boolean };
    }).__ABU_SHELL__ = { mainSupervisesSidecar: true };
    const strings = Object.fromEntries([
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
      'privacyNote',
    ].map((key) => [key, key])) as unknown as ComputerUsePermissionGuideStrings;
    invoke.mockResolvedValueOnce({
      status: 'complete',
      permissions: { screenRead: true, uiControl: true },
      error: null,
    });

    await expect(runComputerUsePermissionGuide({
      requestedByTask: true,
      permissions: { screenRead: false, uiControl: false },
      strings,
    })).resolves.toEqual({
      status: 'complete',
      permissions: { screenRead: true, uiControl: true },
      error: null,
    });
    expect(invoke).toHaveBeenCalledWith(
      'computer_use_permission_guide_show',
      {
        requestedByTask: true,
        permissions: { screenRead: false, uiControl: false },
        strings,
      },
    );

    invoke.mockResolvedValueOnce(undefined);
    await closeComputerUsePermissionGuide();
    expect(invoke).toHaveBeenLastCalledWith(
      'computer_use_permission_guide_close',
    );
  });
});
