/**
 * Stable inbound message id for a plugin platform.
 *
 * `pendingApprovals` de-duplicates an approval answer by
 * `platform:messageId` for thirty minutes, and falls back to a ten-second
 * content window when there is no id. For a bare "同意" that fallback is the
 * difference between a redelivery being swallowed and being replayed as a
 * fresh approval, so a plugin whose payload spells its id `msgId` rather than
 * `msg_id` should not silently land on the weaker path.
 *
 * A manifest may declare the exact path; otherwise the common spellings are
 * tried in order. Anything not found simply yields undefined — the caller
 * keeps its existing fallback.
 */

/** Spellings seen across IM platforms, most specific first. */
const COMMON_MESSAGE_ID_PATHS = [
  'message_key',
  'message_id',
  'messageId',
  'MessageId',
  'MessageID',
  'msg_id',
  'msgId',
  'msgid',
  'MsgId',
  'MsgID',
  'event.message.message_id',
  'data.message_id',
] as const;

function readPath(payload: Record<string, unknown>, path: string): unknown {
  let current: unknown = payload;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Non-empty scalar at `path`, as a string. Objects and arrays are not ids. */
function scalarAt(payload: Record<string, unknown>, path: string): string | undefined {
  const value = readPath(payload, path);
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

export function extractPluginInboundMessageId(
  payload: Record<string, unknown>,
  declaredPath?: string,
): string | undefined {
  if (declaredPath) {
    const declared = scalarAt(payload, declaredPath);
    if (declared) return declared;
  }
  for (const path of COMMON_MESSAGE_ID_PATHS) {
    const found = scalarAt(payload, path);
    if (found) return found;
  }
  return undefined;
}
