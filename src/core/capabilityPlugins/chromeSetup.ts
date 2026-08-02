import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { hasElectronCommandHost } from '@/utils/electronHost';
import { getParentDir } from '@/utils/pathUtils';

export interface ChromeExtensionSetupResult {
  extensionFolderOpened: boolean;
  extensionsPageOpened: boolean;
}

/**
 * Opens the two windows needed for today's bundled-extension setup. A future
 * Chrome Web Store release can replace this helper without changing the
 * capability page or exposing MCP details to users.
 */
export async function openBundledChromeExtensionSetup(
  extensionPath: string,
): Promise<ChromeExtensionSetupResult> {
  let extensionFolderOpened = false;
  let extensionsPageOpened = false;

  try {
    // Windows Explorer commonly opens a directory argument *inside* that
    // directory, which made users think they should drag manifest/scripts one
    // by one. Open its parent instead so browser-extension is visible as the
    // single folder Chrome's “Load unpacked” picker must select.
    await openPath(getParentDir(extensionPath));
    extensionFolderOpened = true;
  } catch {
    // Return both outcomes so the UI can give an honest recovery path.
  }

  try {
    if (hasElectronCommandHost()) {
      // chrome:// is a browser-internal page, not an OS URL scheme. Windows
      // shell.openExternal can hang and eventually show “cannot use a browser
      // to open this app”, so let the Electron host launch Chrome explicitly.
      await invoke('open_chrome_extensions');
    } else {
      await openUrl('chrome://extensions');
    }
    extensionsPageOpened = true;
  } catch {
    // Some OS/browser combinations do not register the chrome:// scheme.
  }

  return { extensionFolderOpened, extensionsPageOpened };
}
