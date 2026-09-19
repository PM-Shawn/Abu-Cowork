'use strict';

// A second tool call must not issue another native close while the first one
// is still pending (including after the transport has stopped waiting).
const pending = new WeakMap();

function requestBrowserTabClose(contents, onClosed, { onRetained = () => {}, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  if (pending.has(contents)) return pending.get(contents);
  let resolve;
  const result = new Promise((done) => { resolve = done; });
  pending.set(contents, result);
  let timer;
  let terminal = false;
  const cleanup = () => {
    terminal = true;
    if (timer !== undefined) unschedule(timer);
    contents.removeListener('destroyed', destroyed);
    contents.removeListener('will-prevent-unload', prevented);
    pending.delete(contents);
  };
  const destroyed = () => {
    cleanup();
    try { onClosed(); } catch (error) {
      console.warn('[browser] Closed tab cleanup failed:', error);
    }
    resolve({ status: 'closed' });
  };
  const prevented = () => {
    onRetained();
    // Electron's preventDefault here OVERRIDES the page's veto. Never call it.
    cleanup();
    resolve({ status: 'requires_user_action', reason: 'The page prevented closing. Keep it open for the user.' });
  };
  contents.on('destroyed', destroyed);
  contents.on('will-prevent-unload', prevented);
  try {
    contents.close({ waitForBeforeUnload: true });
    if (!terminal) {
      timer = schedule(() => resolve({ status: 'closing', reason: 'Closing is pending. Do not retry or force-close this page.' }), 5000);
      timer?.unref?.();
    }
  } catch {
    onRetained();
    cleanup();
    resolve({ status: 'requires_user_action', reason: 'The page could not be closed safely. Keep it open for the user.' });
  }
  return result;
}

module.exports = { requestBrowserTabClose, isBrowserTabClosing: (contents) => pending.has(contents) };
