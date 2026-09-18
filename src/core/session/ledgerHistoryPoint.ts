/**
 * The point in a conversation's ledger that a new run's history ends at.
 *
 * The renderer is the ledger's only writer. Before it dispatches a run whose
 * history the sidecar reads from disk, it makes the ledger say what the user
 * sees — buffered stream-snapshot revisions become ledger lines — and then
 * takes the file's byte size after a flush. That size is the watermark the
 * sidecar reads up to (`loadMessages(convId, { uptoBytes })` in
 * `sidecar/src/shims/conversationStorageRun.ts`).
 *
 * The caller must have awaited the conversation's tracked persistence
 * (`waitForConversationPersistence` in `chatStore.ts`) first, so the user row
 * of the run being dispatched is already queued or written in its final form.
 * A rejected promotion or flush rejects this call; nothing is retried here.
 */
import { flushAndGetLedgerWatermark, promoteStreamSnapshots } from './conversationStorage';

export interface LedgerHistoryPoint {
  /** Byte size of `messages.jsonl` after the promotion and a flush; sits right after a newline byte. */
  ledgerWatermark: number;
  promotedSnapshotEntries: number;
}

export async function takeLedgerHistoryPoint(convId: string): Promise<LedgerHistoryPoint> {
  const promotedSnapshotEntries = await promoteStreamSnapshots(convId);
  const ledgerWatermark = await flushAndGetLedgerWatermark(convId);
  return { ledgerWatermark, promotedSnapshotEntries };
}
