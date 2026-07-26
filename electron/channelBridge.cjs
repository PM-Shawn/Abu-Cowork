/**
 * Shared Tauri-Channel plumbing for main-process host modules.
 *
 * A renderer `Channel` (from @tauri-apps/api/core) crosses the IPC boundary
 * as the string `"__CHANNEL__:<id>"` (preload.cjs's serializeChannels —
 * see the preload header for why the conversion happens there). `<id>` is
 * the callback id the Channel registered with preload's transformCallback.
 * Delivering a message uses the same `tauri:callback` bridge as
 * plugin:event|* — but a Channel's registered callback is the raw
 * reorder-by-index closure from Channel's constructor, which reads
 * `payload.index` / `payload.message`, so the payload envelope here is
 * `{ index: <per-channel incrementing int>, message: <event> }`, NOT the
 * `{event, id, payload}` shape used for plugin:event|listen.
 *
 * This is the single home for that wire contract — fsWatchHost,
 * globalShortcutHost, and updaterHost all ride it. Change the format here
 * (and in preload.cjs) or nowhere.
 */
'use strict';

/**
 * Parse a Channel's wire form ("__CHANNEL__:<id>") into its numeric callback
 * id, or null when the value isn't a serialized channel.
 * @param {unknown} onEvent
 * @returns {number | null}
 */
function parseChannelId(onEvent) {
  if (typeof onEvent !== 'string') return null;
  const m = /^__CHANNEL__:(\d+)$/.exec(onEvent);
  return m ? Number(m[1]) : null;
}

/**
 * Deliver one message to a channel's registered callback. No-op when the
 * sender is gone. The caller owns the per-channel `index` counter (some
 * hosts keep it in a per-subscription table) and passes the current value.
 *
 * Returns whether the message was actually sent — the renderer Channel
 * REORDERS by index, so the caller must only advance its counter on a real
 * send (a skipped index would stall every later message in that channel).
 * @param {import('electron').WebContents | null | undefined} sender
 * @param {number} callbackId
 * @param {number} index
 * @param {unknown} message
 * @returns {boolean} true iff sent
 */
function sendChannelMessage(sender, callbackId, index, message) {
  if (!sender || sender.isDestroyed()) return false;
  sender.send('tauri:callback', { id: callbackId, payload: { index, message } });
  return true;
}

module.exports = { parseChannelId, sendChannelMessage };
