/**
 * Loader for the shared loaded-message-sanitiser fixtures.
 *
 * The fixture file (`src/core/session/__fixtures__/loadedMessageSanitizer.fixtures.json`)
 * is the contract every reader of a conversation ledger is held to. Each case
 * pairs the rows a reader finds on disk with the rows the sanitiser must hand
 * on, so the same file can be replayed by the pure module's own test and by the
 * renderer's wrapper.
 *
 * The two user-facing strings the sanitiser writes into a row differ per
 * reader, so the fixture holds tokens for them and `expectedForText` puts the
 * replaying tier's own strings in their place.
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
import type { LoadedMessageSanitizerText } from '@/core/session/loadedMessageSanitizer';

export interface LoadedMessageSanitizerFixtureCase {
  name: string;
  currentRunMessageId?: string;
  input: unknown[];
  expected: unknown[];
}

// Resolved through `fileURLToPath` on the raw string rather than `new URL(…)`:
// under the happy-dom environment the global `URL` is happy-dom's, and Node's
// fs rejects those instances ("The URL must be of scheme file").
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../core/session/__fixtures__/loadedMessageSanitizer.fixtures.json',
);

const RECOVERED_TOKEN = '<<recovered>>';
const EMPTY_TOKEN = '<<empty>>';

/** The two strings a replay passes to the pure module when it has no locale of its own. */
export const FIXTURE_TEXT: LoadedMessageSanitizerText = {
  runRecoveredAfterRestart: RECOVERED_TOKEN,
  errorEmptyBody: EMPTY_TOKEN,
};

export function loadLoadedMessageSanitizerFixtures(): { cases: LoadedMessageSanitizerFixtureCase[] } {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

/** The inside of a JSON string literal for `value`, so a text with quotes or newlines substitutes safely. */
function jsonStringBody(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** A case's expected rows with the two tokens replaced by the strings a tier actually uses. */
export function expectedForText(expected: unknown[], text: LoadedMessageSanitizerText): unknown[] {
  return JSON.parse(
    JSON.stringify(expected)
      .replaceAll(RECOVERED_TOKEN, jsonStringBody(text.runRecoveredAfterRestart))
      .replaceAll(EMPTY_TOKEN, jsonStringBody(text.errorEmptyBody)),
  );
}
