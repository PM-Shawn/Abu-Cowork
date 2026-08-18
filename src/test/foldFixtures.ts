/**
 * Loader for the shared message-ledger fold fixtures.
 *
 * The fixture file (`src/core/session/__fixtures__/messageLedgerFold.fixtures.json`)
 * is the contract that keeps every port of `foldMessageLog` in step — the
 * renderer TS one, the Electron-main CJS one, and eventually the Rust one in
 * `src-tauri/src/catalog_db.rs`. It is read from disk as raw bytes rather than
 * imported as a module so that all three read literally the same file.
 *
 * Lives under `src/test/` because it uses `node:fs`, which the renderer
 * tsconfig (and the renderer boundary rule) rightly does not allow in `src/`
 * proper.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FoldFixtureExpectation {
  id: string | null;
  content: string;
}

export interface FoldFixtureCase {
  name: string;
  lines: string[];
  expected: {
    messages: FoldFixtureExpectation[];
    corruptCount: number;
    totalLines: number;
  };
}

// Resolved through `fileURLToPath` on the raw string rather than `new URL(…)`:
// under the happy-dom environment the global `URL` is happy-dom's, and Node's
// fs rejects those instances ("The URL must be of scheme file").
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../core/session/__fixtures__/messageLedgerFold.fixtures.json',
);

export function loadFoldFixtures(): FoldFixtureCase[] {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  return (JSON.parse(raw) as { cases: FoldFixtureCase[] }).cases;
}

/**
 * Project a folded result down to the shape the fixtures pin (id + content).
 * Accepts the renderer's `Message[]` and the Electron port's plain objects
 * alike — the whole point is to compare them against one another.
 */
export function projectFolded(
  messages: readonly { id?: string; content?: unknown }[],
): FoldFixtureExpectation[] {
  return messages.map((m) => ({
    id: m.id ?? null,
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));
}
