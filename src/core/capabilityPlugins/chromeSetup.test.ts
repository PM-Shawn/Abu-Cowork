import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openBundledChromeExtensionSetup } from './chromeSetup';

const openPath = vi.fn();
const openUrl = vi.fn();
const invoke = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: (...args: unknown[]) => openPath(...args),
  openUrl: (...args: unknown[]) => openUrl(...args),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function setElectronHost(enabled: boolean) {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  };
  runtime.__ABU_SHELL__ = enabled
    ? { mainSupervisesSidecar: true }
    : undefined;
}

describe('openBundledChromeExtensionSetup', () => {
  beforeEach(() => {
    setElectronHost(false);
    openPath.mockReset();
    openUrl.mockReset();
    invoke.mockReset();
  });

  it('opens the extension parent folder and Chrome extension manager', async () => {
    openPath.mockResolvedValue(undefined);
    openUrl.mockResolvedValue(undefined);

    await expect(openBundledChromeExtensionSetup('/resources/browser-extension'))
      .resolves.toEqual({
        extensionFolderOpened: true,
        extensionsPageOpened: true,
      });
    expect(openPath).toHaveBeenCalledWith('/resources');
    expect(openUrl).toHaveBeenCalledWith('chrome://extensions');
  });

  it('asks the Electron host to launch Chrome for its internal extensions page', async () => {
    setElectronHost(true);
    openPath.mockResolvedValue(undefined);
    invoke.mockResolvedValue(undefined);

    await expect(openBundledChromeExtensionSetup(String.raw`C:\Program Files\Abu\resources\browser-extension`))
      .resolves.toEqual({
        extensionFolderOpened: true,
        extensionsPageOpened: true,
    });
    expect(openPath).toHaveBeenCalledWith(String.raw`C:/Program Files/Abu/resources`);
    expect(invoke).toHaveBeenCalledWith('open_chrome_extensions');
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('reports each failed handoff independently', async () => {
    openPath.mockRejectedValue(new Error('missing'));
    openUrl.mockRejectedValue(new Error('unsupported'));

    await expect(openBundledChromeExtensionSetup('/missing')).resolves.toEqual({
      extensionFolderOpened: false,
      extensionsPageOpened: false,
    });
  });
});
