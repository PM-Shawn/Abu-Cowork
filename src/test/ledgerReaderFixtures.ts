/**
 * Loader for the shared ledger-reader fixtures.
 *
 * The fixture file (`src/core/session/__fixtures__/ledgerReader.fixtures.json`)
 * is the contract that keeps every tier's reader in step: the renderer's
 * `projectLedger`, the Electron-main bundle generated from it, and the Node
 * sidecar reader all replay the same cases. Each case pairs a ledger text with
 * an optional `stream-snapshot.json` payload and pins the projection they must
 * produce, down to which snapshot entries survive.
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

export interface LedgerReaderFixtureCase {
  name: string;
  ledgerText: string;
  snapshot: unknown;
  expected: {
    messages: { id: string | null; content: string }[];
    corruptCount: number;
    totalLines: number;
    ledgerChars: number;
    mergedIds: string[];
    droppedIds: string[];
    discardedWhole: boolean;
  };
}

export interface LedgerWatermarkFixtureCase {
  name: string;
  ledgerText: string;
  uptoBytes?: number;
  expectedText: string | null;
  expectedError: 'watermark_beyond_file' | 'watermark_not_at_line_end' | null;
}

// Resolved through `fileURLToPath` on the raw string rather than `new URL(…)`:
// under the happy-dom environment the global `URL` is happy-dom's, and Node's
// fs rejects those instances ("The URL must be of scheme file").
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../core/session/__fixtures__/ledgerReader.fixtures.json',
);

const DAMAGED_SNAPSHOT = '<<damaged>>';

export function loadLedgerReaderFixtures(): {
  cases: LedgerReaderFixtureCase[];
  watermarkCases: LedgerWatermarkFixtureCase[];
} {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

/** The text `stream-snapshot.json` would hold for a fixture's `snapshot` value. */
export function snapshotTextOf(snapshot: unknown): string | null {
  if (snapshot === null || snapshot === undefined) return null;
  if (snapshot === DAMAGED_SNAPSHOT) return '{not json';
  return JSON.stringify(snapshot);
}
