/**
 * Loader and replay helper for the shared conversation-writer fixtures.
 *
 * The fixture file (`src/core/session/__fixtures__/conversationWriter.fixtures.json`)
 * records, for a handful of operation sequences, the exact bytes each one must
 * leave on disk. Every writer of a conversation is held to the same record:
 * `conversationStorage.ts` through the renderer's memory fs, the shared writer
 * through an in-memory adapter, and the sidecar adapter on a real directory.
 *
 * Read from disk as raw bytes rather than imported as a module so every replay
 * reads literally the same file.
 *
 * Lives under `src/test/` because it uses `node:fs`, which the renderer
 * tsconfig (and the renderer boundary rule) rightly does not allow in `src/`
 * proper.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message } from '@/types';
import type { ConversationMeta } from '@/core/session/conversationStorage';

export type WriterFixtureOp =
  | { op: 'appendMessage'; message: Message }
  | { op: 'replaceMessageById'; message: Message }
  | { op: 'updateLastMessage'; message: Message }
  | { op: 'snapshotMessageRevision'; message: Message }
  | { op: 'appendTruncateEvent'; from: string; pid?: string; removedIds: string[] }
  | { op: 'promoteStreamSnapshots' }
  | { op: 'updateIndexEntry'; meta: ConversationMeta }
  | { op: 'removeIndexEntry' }
  | { op: 'flushWrites' }
  | { op: 'flushIndex' }
  | { op: 'expectFiles'; files: Record<string, string | null> };

export interface WriterFixtureCase {
  name: string;
  convId: string;
  /** Milliseconds the clock reads for the whole case. */
  now: number;
  /** What `Math.random().toString(36).substring(2, 8)` yields for the whole case. */
  randomSuffix: string;
  /**
   * Files that already exist when the case starts, keyed the way `expectFiles`
   * keys them. A case that has none is replayed by a tier that offers no
   * `seedFile`; a case that has some is refused by such a tier rather than
   * silently running against a conversation root that is missing them.
   */
  seedFiles?: Record<string, string>;
  /**
   * The case's consecutive `replaceMessageById` ops are issued as one
   * concurrent burst, which is the only way they can meet in the write queue
   * and merge. Which revision the merged line keeps is then decided by the
   * order the tier's `exists` probes of the ledger complete in: every
   * replacement of an id with nothing queued yet probes the file before it
   * enqueues. A memory filesystem answers those probes in issue order, so the
   * merged line is the last revision; a real filesystem answers them in the
   * kernel's order (measured on macOS: 158 inversions in 2000 concurrent pairs
   * of `fs.access`, `.scratch/p3-0/task8-probe-exists-order.log`), so the
   * merged line keeps an earlier revision often enough to make the bytes a
   * coin flip. A tier backed by real files must not replay such a case as a
   * byte contract.
   */
  concurrentRevisionBurst?: boolean;
  ops: WriterFixtureOp[];
}

/** Subset of the storage API a replay drives; `conversationStorage.ts` and a `ConversationWriter` both satisfy it. */
export interface WriterFixtureTarget {
  appendMessage(convId: string, message: Message): Promise<void>;
  replaceMessageById(convId: string, message: Message): Promise<void>;
  updateLastMessage(convId: string, message: Message): Promise<void>;
  snapshotMessageRevision(convId: string, message: Message): Promise<void>;
  appendTruncateEvent(convId: string, from: string, opts: { pid?: string; removedIds: string[] }): Promise<boolean>;
  promoteStreamSnapshots(convId: string): Promise<number>;
  updateIndexEntry(meta: ConversationMeta): Promise<void>;
  removeIndexEntry(convId: string): Promise<void>;
  flushWrites(): Promise<void>;
  flushIndex(): Promise<void>;
}

// Resolved through `fileURLToPath` on the raw string rather than `new URL(…)`:
// under the happy-dom environment the global `URL` is happy-dom's, and Node's
// fs rejects those instances ("The URL must be of scheme file").
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../core/session/__fixtures__/conversationWriter.fixtures.json',
);

export function loadConversationWriterFixtures(): WriterFixtureCase[] {
  return (JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: WriterFixtureCase[] }).cases;
}

/**
 * Runs the case's ops in order. At each `expectFiles` op it calls `readFile`
 * for every listed path (relative to the conversations root, `/`-separated)
 * and returns the mismatches; `null` means the file must not exist.
 *
 * `seedFile` writes the case's `seedFiles` before the first op, in the same
 * path space `readFile` reads.
 */
export async function replayWriterFixture(
  testCase: WriterFixtureCase,
  target: WriterFixtureTarget,
  readFile: (relativePath: string) => Promise<string | null>,
  seedFile?: (relativePath: string, content: string) => Promise<void>,
): Promise<{ step: number; path: string; expected: string | null; actual: string | null }[]> {
  const seeds = Object.entries(testCase.seedFiles ?? {});
  if (seeds.length > 0 && !seedFile) {
    throw new Error(`fixture case "${testCase.name}" seeds ${seeds.length} file(s); this replay has no seedFile`);
  }
  for (const [path, content] of seeds) await seedFile!(path, content);
  const mismatches: { step: number; path: string; expected: string | null; actual: string | null }[] = [];
  // A run of consecutive replacements is issued without waiting in between, the
  // way a burst of tool results issues them, so the write queue sees them
  // together. Awaiting one before issuing the next would not merge at all: a
  // replacement settles only when its own drain has landed, which empties the
  // queue first. See `concurrentRevisionBurst` for what that costs a tier.
  let replacements: Promise<void>[] = [];
  const settleReplacements = async (): Promise<void> => {
    const issued = replacements;
    replacements = [];
    await Promise.all(issued);
  };
  for (const [step, op] of testCase.ops.entries()) {
    if (op.op === 'replaceMessageById') {
      replacements.push(target.replaceMessageById(testCase.convId, op.message));
      continue;
    }
    await settleReplacements();
    switch (op.op) {
      case 'appendMessage': await target.appendMessage(testCase.convId, op.message); break;
      case 'updateLastMessage': await target.updateLastMessage(testCase.convId, op.message); break;
      case 'snapshotMessageRevision': await target.snapshotMessageRevision(testCase.convId, op.message); break;
      case 'appendTruncateEvent':
        await target.appendTruncateEvent(testCase.convId, op.from, { pid: op.pid, removedIds: op.removedIds });
        break;
      case 'promoteStreamSnapshots': await target.promoteStreamSnapshots(testCase.convId); break;
      case 'updateIndexEntry': await target.updateIndexEntry(op.meta); break;
      case 'removeIndexEntry': await target.removeIndexEntry(testCase.convId); break;
      case 'flushWrites': await target.flushWrites(); break;
      case 'flushIndex': await target.flushIndex(); break;
      case 'expectFiles':
        for (const [path, expected] of Object.entries(op.files)) {
          const actual = await readFile(path);
          if (actual !== expected) mismatches.push({ step, path, expected, actual });
        }
        break;
    }
  }
  await settleReplacements();
  return mismatches;
}
