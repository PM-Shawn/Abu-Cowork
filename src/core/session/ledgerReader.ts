/**
 * The single reader of a conversation's message ledger.
 *
 * `projectLedger` turns the text of `messages.jsonl`, and optionally the text
 * of `stream-snapshot.json`, into the message list a caller shows or sends:
 * the renderer through `conversationStorage.ts`, the Node sidecar through
 * `sidecar/src/shims/conversationStorageRun.ts`. It performs no I/O and writes
 * nothing — each caller fetches the two files the way its own process can, and
 * a caller that owns the snapshot file acts on `snapshot.droppedIds` /
 * `snapshot.discardedWhole` itself.
 *
 * The snapshot is optional by design. A caller that only asks what the durable
 * ledger holds passes none; a caller that restores the conversation passes it
 * so it sees the in-flight revision a crash would otherwise hide.
 *
 * Offsets and `ledgerChars` are JavaScript string lengths, the unit the
 * snapshot's `stamp` and `ledgerBytes` fields are written in. Byte watermarks
 * are a separate concern handled by `decodeLedgerPrefix`.
 */
import type { Message } from '@/types';
import { createLedgerFold } from './messageLedger';

/**
 * The file `projectLedger`'s `snapshotText` comes from: it sits next to
 * `messages.jsonl` in the conversation's directory, and every tier that reads
 * or writes it names it from here.
 */
export const STREAM_SNAPSHOT_FILENAME = 'stream-snapshot.json';

export interface StreamSnapshotEntry {
  message: Message;
  /**
   * Ledger length (string length) the entry was captured against. Absent on a
   * legacy file, written before the field existed; that must keep the
   * unconditional-merge behaviour rather than be read as "stamp zero", which
   * would make every legacy entry look supersede-able by literally any ledger
   * content.
   */
  stamp?: number;
}

interface ParsedSnapshot {
  entries: Map<string, StreamSnapshotEntry>;
  ledgerBytes?: number;
}

export interface LedgerProjection {
  messages: Message[];
  /**
   * Lines that were not parseable JSON objects, over everything the fold saw:
   * the ledger's lines plus the merged snapshot entries applied as trailing
   * puts.
   */
  corruptCount: number;
  /**
   * Non-blank lines the fold saw, corrupt ones included — again the ledger's
   * lines plus the merged snapshot entries applied as trailing puts.
   */
  totalLines: number;
  /** JavaScript string length of the ledger text that was folded. */
  ledgerChars: number;
  snapshot: {
    /** Entries that survived both guards and were folded in, keyed by message id. */
    merged: Map<string, StreamSnapshotEntry>;
    /** Ids dropped by the per-entry supersede rule. */
    droppedIds: string[];
    /** The file-level shrink guard fired: nothing from the snapshot was merged. */
    discardedWhole: boolean;
    /**
     * The ledger length (string length) the snapshot file recorded in its
     * `ledgerBytes` field, when it carries one.
     */
    recordedLedgerChars?: number;
  };
}

/**
 * Read the snapshot file's two on-disk shapes: v2 carries a per-entry `stamp`,
 * v1 carries none and is merged unconditionally. A file-level `ledgerBytes`
 * can appear on either. Anything unparseable yields no entries and no
 * watermark — a damaged snapshot must never take the conversation down with
 * it, since the ledger alone is still a complete, if slightly older, history.
 */
function parseSnapshot(snapshotText: string | null | undefined): ParsedSnapshot {
  const entries = new Map<string, StreamSnapshotEntry>();
  if (snapshotText === null || snapshotText === undefined) return { entries };
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotText);
  } catch {
    return { entries };
  }
  if (typeof parsed !== 'object' || parsed === null) return { entries };
  const file = parsed as { entries?: unknown; messages?: unknown; ledgerBytes?: unknown };
  const ledgerBytes = typeof file.ledgerBytes === 'number' ? file.ledgerBytes : undefined;
  if (Array.isArray(file.entries)) {
    for (const entry of file.entries as { message?: Message; stamp?: unknown }[]) {
      const message = entry?.message;
      if (message && typeof message.id === 'string') {
        entries.set(message.id, {
          message,
          stamp: typeof entry.stamp === 'number' ? entry.stamp : undefined,
        });
      }
    }
  } else if (Array.isArray(file.messages)) {
    for (const message of file.messages as Message[]) {
      if (message && typeof message.id === 'string') entries.set(message.id, { message, stamp: undefined });
    }
  }
  return { entries, ledgerBytes };
}

export function projectLedger(input: {
  ledgerText: string;
  snapshotText?: string | null;
}): LedgerProjection {
  const { ledgerText } = input;
  const fold = createLedgerFold();
  let offset = 0;
  for (const rawLine of ledgerText.split('\n')) {
    fold.apply(rawLine, offset);
    // `String.prototype.split('\n')` eats exactly one '\n' between segments,
    // so re-adding it per segment reconstructs each segment's true starting
    // offset in the ledger text.
    offset += rawLine.length + 1;
  }

  const parsed = parseSnapshot(input.snapshotText);
  const merged = new Map<string, StreamSnapshotEntry>();
  const droppedIds: string[] = [];
  // File-level shrink guard: the ledger is SHORTER than the watermark this
  // snapshot was written against. An append-only ledger's length only grows,
  // so a shorter one means something outside this fold rewrote the file in
  // place since the snapshot was taken — the classic case being a downgrade to
  // a build that knows nothing of snapshots and rewrites the whole file,
  // followed by a re-upgrade. The snapshot's revisions are then relative to a
  // ledger tail that no longer exists, and merging them would overlay stale
  // content on the user's edited history, so none of it is merged. The
  // per-entry rule below only ever drops individual ids, which is why this
  // coarser check runs first and short-circuits it.
  const discardedWhole = parsed.ledgerBytes !== undefined && ledgerText.length < parsed.ledgerBytes;

  if (!discardedWhole) {
    const putOffsets = fold.putOffsetById();
    const removedOffsets = fold.removedOffsetById();
    for (const [id, entry] of parsed.entries) {
      if (entry.stamp === undefined) {
        // Nothing to compare against the ledger, so the entry merges — the
        // behaviour every entry had before stamps existed.
        merged.set(id, entry);
        continue;
      }
      // Per-entry supersede rule: at or after the offset the entry was stamped
      // against, the ledger either put the same id again (a durable checkpoint
      // landed and the process that wrote it never got to delete the
      // now-superseded snapshot) or removed the id with a truncate / tomb /
      // loopDrop (a stale entry must not revive a message the user already
      // deleted). Either way the ledger holds the newer version. A stamp that
      // outreaches the current ledger is stale for the same reason the
      // file-level guard exists — something outside this fold rewrote the
      // file — and is caught per entry even when the file-level watermark is
      // missing. An entry the ledger has genuinely not touched since capture
      // survives: that is the crash protection the snapshot exists for.
      const putOffset = putOffsets.get(id);
      const removedOffset = removedOffsets.get(id);
      const stale =
        (putOffset !== undefined && putOffset >= entry.stamp)
        || (removedOffset !== undefined && removedOffset >= entry.stamp)
        || ledgerText.length < entry.stamp;
      if (stale) droppedIds.push(id);
      else merged.set(id, entry);
    }
    // Offsets were read above; the trailing puts carry none, so they cannot
    // make a later entry of the same snapshot look superseded.
    for (const entry of merged.values()) fold.apply(JSON.stringify(entry.message));
  }

  const { messages, corruptCount, totalLines } = fold.result();
  return {
    messages,
    corruptCount,
    totalLines,
    ledgerChars: ledgerText.length,
    snapshot: { merged, droppedIds, discardedWhole, recordedLedgerChars: parsed.ledgerBytes },
  };
}

export type LedgerWatermarkErrorCode = 'watermark_beyond_file' | 'watermark_not_at_line_end';

export class LedgerWatermarkError extends Error {
  readonly code: LedgerWatermarkErrorCode;
  readonly uptoBytes: number;
  readonly fileBytes: number;

  constructor(code: LedgerWatermarkErrorCode, uptoBytes: number, fileBytes: number) {
    super(`${code} (uptoBytes=${uptoBytes}, fileBytes=${fileBytes})`);
    this.name = 'LedgerWatermarkError';
    this.code = code;
    this.uptoBytes = uptoBytes;
    this.fileBytes = fileBytes;
  }
}

const LINE_FEED = 0x0a;

/**
 * Decode the ledger up to a byte watermark. The watermark is a file size the
 * single writer reported after a flush, so it always sits right after a
 * newline byte; anything else means the reader and the writer disagree about
 * the file and the read is refused.
 */
export function decodeLedgerPrefix(bytes: Uint8Array, uptoBytes?: number): string {
  const decoder = new TextDecoder('utf-8');
  if (uptoBytes === undefined) return decoder.decode(bytes);
  if (!Number.isInteger(uptoBytes) || uptoBytes < 0) {
    throw new LedgerWatermarkError('watermark_not_at_line_end', uptoBytes, bytes.byteLength);
  }
  if (uptoBytes > bytes.byteLength) {
    throw new LedgerWatermarkError('watermark_beyond_file', uptoBytes, bytes.byteLength);
  }
  if (uptoBytes > 0 && bytes[uptoBytes - 1] !== LINE_FEED) {
    throw new LedgerWatermarkError('watermark_not_at_line_end', uptoBytes, bytes.byteLength);
  }
  return decoder.decode(bytes.subarray(0, uptoBytes));
}
