import { openPath, openUrl } from '@tauri-apps/plugin-opener';

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
    await openPath(extensionPath);
    extensionFolderOpened = true;
  } catch {
    // Return both outcomes so the UI can give an honest recovery path.
  }

  try {
    await openUrl('chrome://extensions');
    extensionsPageOpened = true;
  } catch {
    // Some OS/browser combinations do not register the chrome:// scheme.
  }

  return { extensionFolderOpened, extensionsPageOpened };
}
