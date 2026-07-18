/**
 * Inbound-message validation for the preview "select element" inspect
 * channel (`abu-preview-inspect:*`, see
 * docs/2026-07-19-preview-element-select-design.md §传输契约).
 *
 * The loopback iframe is cross-origin from the app shell, so postMessage is
 * the only transport. Every inbound message must clear FOUR gates before
 * being trusted: the real sender window (`event.source`), the real sender
 * origin (`event.origin`), the message shape/type, and a per-session nonce
 * (anti-replay/anti-cross-talk, not a secret — see design doc). A payload
 * size cap is belt-and-suspenders on top of the picker script's own
 * server-side truncation.
 */

const MAX_PAYLOAD_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface InspectSelectionCheckParams {
  /** `MessageEvent.source` from the received postMessage event. */
  source: unknown;
  /** `MessageEvent.origin` from the received postMessage event. */
  origin: string;
  /** `MessageEvent.data` from the received postMessage event. */
  data: unknown;
  /** Origin derived from the current `htmlPreviewUrl` (`new URL(...).origin`). */
  expectedOrigin: string;
  /** The iframe's `contentWindow` at message-receive time, or null if unmounted. */
  expectedSource: unknown;
  /** The nonce minted when inspect mode was last armed, or null if disarmed. */
  expectedNonce: string | null;
}

/**
 * Returns true only if `data` is a well-formed
 * `abu-preview-inspect:selected` message from the exact iframe window we
 * armed, on the exact origin we expect, carrying the nonce of the
 * currently-armed session, with a payload that at least looks like a
 * `BrowserElementPayload` and isn't oversized.
 */
export function isValidInspectSelection(params: InspectSelectionCheckParams): boolean {
  const { source, origin, data, expectedOrigin, expectedSource, expectedNonce } = params;

  if (!expectedSource || source !== expectedSource) return false;
  if (origin !== expectedOrigin) return false;
  if (!isRecord(data)) return false;
  if (data.type !== 'abu-preview-inspect:selected') return false;
  if (!expectedNonce || data.nonce !== expectedNonce) return false;

  const payload = data.payload;
  if (!isRecord(payload) || typeof payload.outerHTML !== 'string') return false;

  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return false;
  }
  if (serialized.length > MAX_PAYLOAD_BYTES) return false;

  return true;
}
