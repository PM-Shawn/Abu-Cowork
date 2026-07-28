import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openBundledChromeExtensionSetup } from './chromeSetup';

const openPath = vi.fn();
const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: (...args: unknown[]) => openPath(...args),
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

describe('openBundledChromeExtensionSetup', () => {
  beforeEach(() => {
    openPath.mockReset();
    openUrl.mockReset();
  });

  it('opens the bundled extension folder and Chrome extension manager', async () => {
    openPath.mockResolvedValue(undefined);
    openUrl.mockResolvedValue(undefined);

    await expect(openBundledChromeExtensionSetup('/resources/browser-extension'))
      .resolves.toEqual({
        extensionFolderOpened: true,
        extensionsPageOpened: true,
      });
    expect(openPath).toHaveBeenCalledWith('/resources/browser-extension');
    expect(openUrl).toHaveBeenCalledWith('chrome://extensions');
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
