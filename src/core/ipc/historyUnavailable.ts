/**
 * The typed failure of an `agent.start` that names a ledger watermark: the
 * sidecar could not read the conversation's history up to it. The sidecar
 * throws it as JSON-RPC error `-32010` (`sidecar/src/agentLoopHost.ts`); the
 * shell recognises it and ends the send as a visible, retryable failure
 * without asking the sidecar again.
 *
 * The payload is numbers and fixed vocabulary only — never a path or content.
 * Pure and import-free: both tiers bundle this file.
 */
export const HISTORY_UNAVAILABLE_RPC_CODE = -32010;
export const HISTORY_UNAVAILABLE_CODE = 'history_unavailable' as const;

export type HistoryUnavailableReason =
  /** The watermark is larger than the ledger file (or the file is missing). */
  | 'watermark_beyond_file'
  /** The watermark does not sit right after a newline byte. */
  | 'watermark_not_at_line_end'
  /** The ledger exists but could not be read. */
  | 'ledger_unreadable'
  /** The ledger prefix does not hold the user row of the run being started. */
  | 'current_turn_missing';

const REASONS: ReadonlySet<string> = new Set<HistoryUnavailableReason>([
  'watermark_beyond_file',
  'watermark_not_at_line_end',
  'ledger_unreadable',
  'current_turn_missing',
]);

export interface HistoryUnavailableData {
  code: typeof HISTORY_UNAVAILABLE_CODE;
  reason: HistoryUnavailableReason;
  /** The watermark the shell sent. */
  uptoBytes: number;
  /** The ledger's size as the sidecar measured it; 0 when it could not be measured. */
  fileBytes: number;
}

export function historyUnavailableData(
  reason: HistoryUnavailableReason,
  uptoBytes: number,
  fileBytes: number,
): HistoryUnavailableData {
  return { code: HISTORY_UNAVAILABLE_CODE, reason, uptoBytes, fileBytes };
}

function isByteCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * The typed payload of a rejected `agent.start`, or null for any other error.
 * Duck-typed on `code` and `data`, so it reads an error object as well as a
 * plain object taken off the wire.
 */
export function parseHistoryUnavailableError(err: unknown): HistoryUnavailableData | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, data } = err as { code?: unknown; data?: unknown };
  if (code !== HISTORY_UNAVAILABLE_RPC_CODE || typeof data !== 'object' || data === null) return null;
  const payload = data as Record<string, unknown>;
  if (
    payload.code !== HISTORY_UNAVAILABLE_CODE
    || typeof payload.reason !== 'string'
    || !REASONS.has(payload.reason)
    || !isByteCount(payload.uptoBytes)
    || !isByteCount(payload.fileBytes)
  ) return null;
  return historyUnavailableData(payload.reason as HistoryUnavailableReason, payload.uptoBytes, payload.fileBytes);
}
