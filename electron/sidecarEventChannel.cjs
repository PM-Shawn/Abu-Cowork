'use strict';

const SIDECAR_EVENT_CHANNEL = 'abu:sidecar-event';
const SIDECAR_BRIDGE_STATE_CHANNEL = 'abu:sidecar-bridge-state';
const SIDECAR_ID = 'abu-sidecar';

const EVENT_TYPE_BY_NAME = new Map([
  [`mcp-msg-${SIDECAR_ID}`, 'message'],
  [`mcp-err-${SIDECAR_ID}`, 'error'],
  [`mcp-close-${SIDECAR_ID}`, 'close'],
  [`mcp-hung-${SIDECAR_ID}`, 'hung'],
]);

/**
 * Project a legacy Tauri-shaped sidecar event onto the dedicated Electron
 * main→preload channel. Other MCP process ids deliberately stay on the
 * generic event bridge.
 *
 * @param {string} eventName
 * @param {unknown} payload
 * @returns {{ type: 'message' | 'error' | 'close' | 'hung', payload: string } | null}
 */
function toDedicatedSidecarEvent(eventName, payload) {
  const type = EVENT_TYPE_BY_NAME.get(eventName);
  if (!type) return null;
  return {
    type,
    payload: typeof payload === 'string' ? payload : '',
  };
}

/**
 * @param {import('electron').WebContents | null | undefined} webContents
 * @param {{ type: 'message' | 'error' | 'close' | 'hung', payload: string, sequence: number, generation: number }} event
 * @returns {boolean} whether the event was handed to a live renderer
 */
function sendDedicatedSidecarEvent(webContents, event) {
  if (!webContents || webContents.isDestroyed()) return false;
  try {
    webContents.send(SIDECAR_EVENT_CHANNEL, event);
    return true;
  } catch {
    // WebContents can be destroyed between the check above and send(). The
    // caller will fall back to the compatibility event bridge and record a
    // delivery miss if that renderer transport is gone too.
    return false;
  }
}

module.exports = {
  SIDECAR_BRIDGE_STATE_CHANNEL,
  SIDECAR_EVENT_CHANNEL,
  sendDedicatedSidecarEvent,
  toDedicatedSidecarEvent,
};
