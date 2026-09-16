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
 * does), windows are revealed with `showInactive()` instead of `show()` and,
 * on macOS, main.cjs hides the Dock icon so the app never becomes frontmost.
 *
 * main.cjs resolves the policy once at boot (`configureWindowShowPolicy`) and
 * every module that reveals a window — main.cjs for the main/transition
 * windows, guiHost.cjs for the pet / overlay / stop-button windows — goes
 * through `revealWindow(win)`, which reads that resolved policy. Any window
 * revealed with a bare `win.show()` would activate the app and defeat the
 * quiet mode for the whole run, so new window families must use this helper.
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

/** The user-facing default: a process that never configured the policy reveals windows with `show()`. */
const DEFAULT_WINDOW_SHOW_POLICY = Object.freeze({ quiet: false, hideDock: false });

/** @type {{ quiet: boolean, hideDock: boolean }} */
let activePolicy = DEFAULT_WINDOW_SHOW_POLICY;

/**
 * Resolve the policy from the process environment and make it the one
 * `revealWindow()` uses when called without an explicit policy. main.cjs calls
 * this once at boot, before any window exists; it is safe to call again (the
 * newest resolution wins), which is what the unit tests rely on.
 * @param {Parameters<typeof resolveWindowShowPolicy>[0]} input
 * @returns {{ quiet: boolean, hideDock: boolean }}
 */
function configureWindowShowPolicy(input) {
  activePolicy = Object.freeze(resolveWindowShowPolicy(input));
  return activePolicy;
}

/** The policy `revealWindow()` applies by default (the last `configureWindowShowPolicy()` result, or the user-facing default). */
function getWindowShowPolicy() {
  return activePolicy;
}

/**
 * Reveal a window according to the policy: `showInactive()` keeps the window
 * visible and rendered without activating the app; `show()` is the normal
 * user-facing path. Without an explicit `policy` the configured one applies,
 * so modules that do not own the resolution (guiHost.cjs) can still honour it.
 * @param {{ show: () => void, showInactive: () => void }} win
 * @param {{ quiet: boolean }} [policy]
 */
function revealWindow(win, policy = activePolicy) {
  if (policy.quiet) {
    win.showInactive();
  } else {
    win.show();
  }
}

module.exports = {
  QUIET_WINDOW_ENV,
  resolveWindowShowPolicy,
  configureWindowShowPolicy,
  getWindowShowPolicy,
  revealWindow,
};
