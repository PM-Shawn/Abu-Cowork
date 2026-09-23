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

/**
 * Run something with a window held in front of every other application, then
 * put the window back the way it was.
 *
 * This exists for the consequential-action dialog. Computer Use deliberately
 * does not steal the foreground — that is the whole reason the user keeps
 * control of their screen while Abu works — but it means that by the time Abu
 * asks "should I really send this?", the app it is driving owns the
 * foreground and Abu's own window is behind it. The dialog is modal to that
 * window, and Windows will not let a background process take the foreground,
 * so the most consequential question of the whole run is the one most likely
 * to be answered without being seen.
 *
 * `show()` alone is not enough for the same reason. Always-on-top does not
 * require foreground rights, so it is the part that actually raises the
 * window; the rest is best-effort and safe to fail.
 *
 * This is the one reveal that goes around `revealWindow()`: the quiet policy's
 * `showInactive()` declines to activate the app, which is the opposite of what
 * a consent dialog needs. The quiet policy only applies to the E2E suite, and
 * the suite never drives a Computer Use consent dialog.
 *
 * The previous always-on-top state is restored even if the callback throws —
 * a consent dialog must not leave the app pinned over everything else.
 *
 * @param {object|null} win BrowserWindow, or null when there is no window.
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 * @template T
 */
async function withWindowInFront(win, run) {
  if (!win) return run();
  let restore = null;
  try {
    restore = win.isAlwaysOnTop();
    if (win.isMinimized?.()) win.restore();
    win.setAlwaysOnTop(true);
    win.show();
  } catch {
    // A destroyed or half-torn-down window must not turn a consent prompt
    // into a crash; asking behind another window still beats not asking.
  }
  try {
    return await run();
  } finally {
    if (restore !== null) {
      try { win.setAlwaysOnTop(restore); } catch { /* window went away */ }
    }
  }
}

module.exports = {
  QUIET_WINDOW_ENV,
  resolveWindowShowPolicy,
  configureWindowShowPolicy,
  getWindowShowPolicy,
  revealWindow,
  withWindowInFront,
};
