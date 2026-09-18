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
import {
  flushAndGetLedgerWatermark,
  hasArmedStreamSnapshot,
  promoteStreamSnapshots,
} from './conversationStorage';

/**
 * How many times the point is taken before the conversation is declared
 * unable to stand still. A late frame of the turn that just ended arms one
 * more revision while the promotion runs, which the round after it covers;
 * a conversation that is still arming revisions after three rounds has a
 * live writer the watermark can never catch.
 */
const MAX_ROUNDS = 3;

/**
 * The ledger cannot be brought level with what the user sees, so the run is
 * not dispatched. Ends the send as a visible, retryable failure through the
 * params-build failure path, which is the alternative to sending a watermark
 * that omits part of the conversation.
 */
export class LedgerHistoryPointError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, rounds: number) {
    super(`ledger history point: "${conversationId}" armed a new revision in each of ${rounds} rounds`);
    this.name = 'LedgerHistoryPointError';
    this.conversationId = conversationId;
  }
}

export interface LedgerHistoryPoint {
  /** Byte size of `messages.jsonl` after the promotion and a flush; sits right after a newline byte. */
  ledgerWatermark: number;
  promotedSnapshotEntries: number;
}

export async function takeLedgerHistoryPoint(convId: string): Promise<LedgerHistoryPoint> {
  let promotedSnapshotEntries = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    promotedSnapshotEntries += await promoteStreamSnapshots(convId);
    const ledgerWatermark = await flushAndGetLedgerWatermark(convId);
    if (!hasArmedStreamSnapshot(convId)) return { ledgerWatermark, promotedSnapshotEntries };
  }
  throw new LedgerHistoryPointError(convId, MAX_ROUNDS);
}
