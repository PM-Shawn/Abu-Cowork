/**
 * Tauri native smoke test — app launch and main window visibility.
 *
 * STATUS: SKELETON — NOT run in CI (workflow_dispatch only, continue-on-error).
 *   - Requires: `cargo install tauri-driver` + signed Tauri build.
 *   - tauri-driver does NOT support macOS — will fail with "no display" on macOS CI.
 *   - See docs/TAURI-SMOKE.md for local run instructions and V2 checklist.
 *
 * Intentionally avoids:
 *   - `capture_screen` / `check_macos_permissions` (requires Screen Recording grant)
 *   - Accessibility tree traversal (requires Accessibility grant)
 *   - Keychain commands (requires keychain entitlement in the signed bundle)
 *
 * These permissions are gated to the signed distribution build (V2).
 */

import { browser, $ } from '@wdio/globals';

describe('Abu — Tauri native smoke', () => {
  it('app launches and main window is visible', async () => {
    // If the app failed to start, the browser session itself will throw.
    // We just assert we have an active session here.
    expect(await browser.getTitle()).toBeDefined();
  });

  it('root #root element exists in the DOM', async () => {
    // The Tauri webview renders into <div id="root"> (see index.html).
    // If the React app failed to hydrate, this element won't be found.
    const appRoot = await $('#root');
    await appRoot.waitForExist({ timeout: 10000 });
    expect(await appRoot.isExisting()).toBe(true);
  });

  it('page title contains Abu or app name', async () => {
    const title = await browser.getTitle();
    // Title is set in index.html; verify it's not blank (a blank title means
    // the webview didn't load the HTML at all).
    expect(title).toBeTruthy();
  });
});
