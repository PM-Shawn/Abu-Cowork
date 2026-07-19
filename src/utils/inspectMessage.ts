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

// The picker script raw-truncates outerHTML to 40960 chars before it ever
// hits the wire, but JSON.stringify (this file's own size check) then
// JSON-escapes that string: quote/backslash/newline-dense HTML can expand
// materially under `\"`/`\\`/`\n` escaping, and computedStyle + text(≤2000)
// add on top. 64KB was too tight against the 40960-char raw truncation and
// could silently drop a legitimate pick (isValidInspectSelection → false,
// inspect stays armed with no feedback). 128KB gives headroom for
// JSON-escaping overhead while still bounding the message size.
const MAX_PAYLOAD_BYTES = 128 * 1024;

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

/**
 * `BrowserElementPayload.pageUrl` for a preview-tab pick is the loopback
 * iframe's `location.href` — `http://127.0.0.1:<port>/files/<TOKEN>/<root_id>/<rel_path>`
 * (see preview_server.rs). Writing that straight into `ChatReference.source.path`
 * would leak the per-launch loopback file-access token into the LLM message
 * and persisted history. Prefer the real on-disk file path the panel already
 * knows (`previewFilePath`); only fall back to stripping the loopback prefix
 * off `pageUrl` when that's unavailable (e.g. a future non-preview caller).
 */
export function resolveReferencePath(previewFilePath: string | null | undefined, pageUrl: string): string {
  if (previewFilePath) return previewFilePath;
  return pageUrl.replace(/^https?:\/\/127\.0\.0\.1(:\d+)?\/files\/[^/]+\/[^/]+\//, '');
}
