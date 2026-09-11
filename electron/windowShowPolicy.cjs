'use strict';

/**
 * Window reveal policy for the real-Electron E2E suite.
 *
 * Every E2E test launches its own Electron process, and `BrowserWindow.show()`
 * activates the app — on a developer machine that steals keyboard focus from
 * whatever they were doing, ~40 times per full run. Electron has no headless
 * mode (its own CI guide says "use Xvfb on Linux, nothing on macOS/Windows"),
 * so the suite still needs a real, rendered window: drag-region specs read
 * window bounds and the browser-view specs assert on native WebContentsView
 * attachment. What it does NOT need is app activation.
 *
 * When the launcher sets ABU_E2E_QUIET_WINDOW=1 (tests/e2e/electronHelpers.ts
 * does), main.cjs reveals windows with `showInactive()` instead of `show()`
 * and, on macOS, hides the Dock icon so the app never becomes frontmost.
 *
 * The flag is honoured under the same gate as the other ABU_E2E_* controls
 * (`allowE2E`: non-packaged build, or a packaged build that explicitly opted in
 * via ABU_PACKAGED_E2E=1), so a stray variable in a user's shell cannot make a
 * normal launch come up behind other windows.
 */

const QUIET_WINDOW_ENV = 'ABU_E2E_QUIET_WINDOW';

/**
 * @param {{ env: NodeJS.ProcessEnv | undefined, allowE2E: boolean, platform: string }} input
 * @returns {{ quiet: boolean, hideDock: boolean }}
 */
function resolveWindowShowPolicy({ env, allowE2E, platform }) {
  const quiet = allowE2E === true && env?.[QUIET_WINDOW_ENV] === '1';
  return { quiet, hideDock: quiet && platform === 'darwin' };
}

/**
 * Reveal a window according to the policy: `showInactive()` keeps the window
 * visible and rendered without activating the app; `show()` is the normal
 * user-facing path.
 * @param {{ show: () => void, showInactive: () => void }} win
 * @param {{ quiet: boolean }} policy
 */
function revealWindow(win, policy) {
  if (policy.quiet) {
    win.showInactive();
  } else {
    win.show();
  }
}

module.exports = { QUIET_WINDOW_ENV, resolveWindowShowPolicy, revealWindow };
