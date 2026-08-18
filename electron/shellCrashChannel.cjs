/**
 * Buffered main→renderer delivery for severe shell crashes.
 *
 * The main process records crashes locally itself, but it cannot decide whether
 * the user allows a REMOTE report — the telemetry opt-out and the console target
 * live in renderer stores. So it forwards severe crashes as a `runtime-crash`
 * event and the renderer (src/core/observability/shellCrashReports.ts) makes the
 * call.
 *
 * tauriHost's emitEvent is fire-and-forget: it delivers to whoever is subscribed
 * RIGHT NOW and returns that count. Crash observers are installed at main-module
 * load, while the renderer's subscriber only appears after preload + page load +
 * React mount — so exactly the crashes that matter most (the ones during
 * startup) would be delivered to zero listeners and vanish. This module keeps a
 * small bounded queue for that window and flushes it when a subscriber appears
 * (tauriHost calls flushPendingShellCrashReports from its `plugin:event|listen`
 * handler, the same flush-on-subscribe shape deepLinkHost already uses).
 *
 * Scope is deliberately just this one channel: emitEvent/deliver stay unchanged
 * for every other event type.
 */
'use strict';

const SHELL_CRASH_EVENT = 'runtime-crash';
/**
 * Enough to carry a startup crash burst without letting a crash loop in a
 * renderer-less process grow the queue without bound. Oldest is dropped first —
 * the local jsonl log keeps every one of them regardless.
 */
const MAX_PENDING_SHELL_CRASHES = 5;

let emitFn = null; // injected tauriHost.emitEvent (returns delivered count)
let pendingCrashes = [];

/**
 * @param {{ emit: (event: string, payload: unknown) => number }} deps
 */
function initShellCrashChannel({ emit } = {}) {
  emitFn = typeof emit === 'function' ? emit : null;
}

/**
 * Queue a crash and try to deliver immediately. Never throws: a crash record
 * must not become the reason for a second crash.
 * @param {object} crash
 * @returns {number} number of crash records delivered by this call
 */
function reportShellCrash(crash) {
  pendingCrashes.push(crash);
  if (pendingCrashes.length > MAX_PENDING_SHELL_CRASHES) pendingCrashes.shift();
  return flushPendingShellCrashReports();
}

/**
 * Deliver queued crashes in arrival order, stopping at the first one that
 * reaches no live subscriber (that one and everything after it stay queued).
 * Idempotent and safe to call repeatedly.
 * @returns {number} number of crash records delivered by this call
 */
function flushPendingShellCrashReports() {
  if (!emitFn || pendingCrashes.length === 0) return 0;
  const queued = pendingCrashes;
  for (let index = 0; index < queued.length; index++) {
    let delivered = 0;
    try {
      delivered = emitFn(SHELL_CRASH_EVENT, queued[index]);
    } catch {
      // A dead/absent renderer transport must never escalate a crash record.
      delivered = 0;
    }
    if (delivered <= 0) {
      // No subscriber yet — keep this crash and the rest for the next flush.
      pendingCrashes = queued.slice(index);
      return index;
    }
  }
  pendingCrashes = [];
  return queued.length;
}

/** Test-only reset so headless harnesses can exercise a clean module. */
function __resetForTest() {
  emitFn = null;
  pendingCrashes = [];
}

module.exports = {
  SHELL_CRASH_EVENT,
  MAX_PENDING_SHELL_CRASHES,
  initShellCrashChannel,
  reportShellCrash,
  flushPendingShellCrashReports,
  __resetForTest,
};
