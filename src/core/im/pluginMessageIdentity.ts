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
];

function extractPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringFromPath(payload: Record<string, unknown>, path: string): string | undefined {
  const value = extractPath(payload, path);
  if (value === undefined || value === null) return undefined;
  const str = String(value);
  return str === '' ? undefined : str;
}

export function extractPluginInboundMessageId(
  payload: Record<string, unknown>,
  explicitPath?: string,
): string | undefined {
  if (explicitPath) {
    const explicit = stringFromPath(payload, explicitPath);
    if (explicit) return explicit;
  }

  for (const path of COMMON_MESSAGE_ID_PATHS) {
    const fallback = stringFromPath(payload, path);
    if (fallback) return fallback;
  }

  return undefined;
}
