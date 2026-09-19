/**
 * Typed IPC oversize error (#549). The main process and preload throw it as a
 * plain message (Electron IPC keeps only `message`), formatted by
 * `electron/ipcPayloadError.cjs` — keep `formatPayloadTooLargeMessage` in sync;
 * `payloadTooLarge.contract.test.ts` pins the two together.
 */
export const IPC_MAX_ARGS_BYTES = 8 * 1024 * 1024;
export const IPC_MAX_RAW_BODY_BYTES = 128 * 1024 * 1024;
export const PAYLOAD_TOO_LARGE_CODE = 'payload_too_large' as const;

export interface PayloadTooLargeFields {
  bytes: number;
  limit: number;
  method: string;
}

export function formatPayloadTooLargeMessage(fields: PayloadTooLargeFields): string {
  return `${PAYLOAD_TOO_LARGE_CODE} ${JSON.stringify({
    code: PAYLOAD_TOO_LARGE_CODE,
    bytes: fields.bytes,
    limit: fields.limit,
    method: fields.method,
  })}`;
}

export class PayloadTooLargeError extends Error {
  readonly code = PAYLOAD_TOO_LARGE_CODE;
  readonly retryable = false as const;
  readonly bytes: number;
  readonly limit: number;
  readonly method: string;

  constructor(bytes: number, limit: number, method: string) {
    super(formatPayloadTooLargeMessage({ bytes, limit, method }));
    this.name = 'PayloadTooLargeError';
    this.bytes = bytes;
    this.limit = limit;
    this.method = method;
  }
}

const WIRE_PATTERN = /payload_too_large (\{"code":"payload_too_large"[^}]*\})/;

export function parsePayloadTooLargeError(err: unknown, method?: string): PayloadTooLargeError | null {
  if (err instanceof PayloadTooLargeError) {
    return method && method !== err.method ? new PayloadTooLargeError(err.bytes, err.limit, method) : err;
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const match = WIRE_PATTERN.exec(message);
  if (!match) return null;
  try {
    const fields = JSON.parse(match[1]) as Record<string, unknown>;
    if (
      !Number.isSafeInteger(fields.bytes)
      || !Number.isSafeInteger(fields.limit)
      || typeof fields.method !== 'string'
    ) return null;
    return new PayloadTooLargeError(fields.bytes as number, fields.limit as number, method ?? fields.method);
  } catch {
    return null;
  }
}

export function isPayloadTooLargeError(err: unknown): boolean {
  return parsePayloadTooLargeError(err) !== null;
}
