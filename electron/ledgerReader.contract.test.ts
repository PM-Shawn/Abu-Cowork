// @vitest-environment node

/**
 * Contract test: the bundle the Electron main process requires is the same
 * reader the renderer and the sidecar run. It replays both shared fixture
 * files through the generated CommonJS and through the TypeScript and demands
 * identical output, and it fails when the tracked bundle is older than its
 * source.
 *
 * Why this exists: the catalog (SQLite + FTS) is a projection of the very same
 * JSONL the UI renders, so the two must agree on what a ledger contains. The
 * main process cannot import the TypeScript directly (ESM + TS + the `src/`
 * boundary rule), so it requires a bundle generated from it — and a generated
 * file is only as good as the check that it is current.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tsReader from '../src/core/session/ledgerReader';
import { loadFoldFixtures, projectFolded } from '../src/test/foldFixtures';
import { loadLedgerReaderFixtures, snapshotTextOf } from '../src/test/ledgerReaderFixtures';
import { isBundleCurrent } from '../scripts/gen-ledger-reader.mjs';

const require_ = createRequire(import.meta.url);
const cjs = require_('./generated/ledgerReader.cjs') as typeof tsReader;

// Everything this file reaches for on disk is resolved from the file's own
// location, so the suite says the same thing whatever directory vitest was
// started from.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_PATH = join(ROOT, 'electron/generated/ledgerReader.cjs');

describe('electron/generated/ledgerReader.cjs ↔ src/core/session/ledgerReader.ts', () => {
  it('the tracked bundle matches a fresh build', () => {
    execFileSync(process.execPath, [join(ROOT, 'scripts/gen-ledger-reader.mjs'), '--check'], {
      cwd: ROOT,
      stdio: 'pipe',
    });
  });

  it('a CRLF checkout of the tracked bundle still counts as current', () => {
    // A machine with core.autocrlf=true checks the bundle out with \r\n while
    // esbuild emits \n. That is the same bundle, so the freshness check must
    // not read it as stale and send the developer regenerating a file git then
    // reports as unchanged.
    const tracked = readFileSync(BUNDLE_PATH, 'utf8');
    const asCrlf = tracked.replace(/\n/g, '\r\n');
    expect(asCrlf).not.toBe(tracked);
    expect(isBundleCurrent(asCrlf, tracked)).toBe(true);
    expect(isBundleCurrent(tracked, tracked)).toBe(true);
    expect(isBundleCurrent(`${tracked}// edited by hand\n`, tracked)).toBe(false);
  });

  it('exports everything the main process reads a ledger with', () => {
    expect(typeof cjs.projectLedger).toBe('function');
    expect(typeof cjs.decodeLedgerPrefix).toBe('function');
    expect(typeof cjs.foldMessageLog).toBe('function');
    expect(typeof cjs.createLedgerFold).toBe('function');
    expect(typeof cjs.LedgerWatermarkError).toBe('function');
    expect(cjs.STREAM_SNAPSHOT_FILENAME).toBe(tsReader.STREAM_SNAPSHOT_FILENAME);
  });

  for (const testCase of loadFoldFixtures()) {
    it(`fold fixture: ${testCase.name}`, () => {
      const a = cjs.foldMessageLog(testCase.lines);
      const b = tsReader.foldMessageLog(testCase.lines);
      expect(projectFolded(a.messages)).toEqual(testCase.expected.messages);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  }

  const { cases, watermarkCases } = loadLedgerReaderFixtures();
  for (const testCase of cases) {
    it(`reader fixture: ${testCase.name}`, () => {
      const input = { ledgerText: testCase.ledgerText, snapshotText: snapshotTextOf(testCase.snapshot) };
      const a = cjs.projectLedger(input);
      const b = tsReader.projectLedger(input);
      expect(projectFolded(a.messages)).toEqual(testCase.expected.messages);
      expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
      expect([...a.snapshot.merged.keys()]).toEqual([...b.snapshot.merged.keys()]);
      expect(a.snapshot.droppedIds).toEqual(b.snapshot.droppedIds);
      expect(a.snapshot.discardedWhole).toBe(b.snapshot.discardedWhole);
      expect(a.snapshot.recordedLedgerChars).toBe(b.snapshot.recordedLedgerChars);
    });
  }

  it('the catalog option — no snapshot — folds the durable ledger alone', () => {
    // `scanConversationFile` in electron/catalogDb.cjs calls it exactly this
    // way, so the case every conversation in the catalog goes through is the
    // one pinned here.
    const withSnapshot = cases.find((c) => c.expected.mergedIds.length > 0)!;
    const projection = cjs.projectLedger({ ledgerText: withSnapshot.ledgerText });
    expect(projection.snapshot.merged.size).toBe(0);
    expect(JSON.stringify(projection.messages))
      .toBe(JSON.stringify(cjs.foldMessageLog(withSnapshot.ledgerText.split('\n')).messages));
  });

  for (const testCase of watermarkCases) {
    it(`watermark fixture: ${testCase.name}`, () => {
      const bytes = new TextEncoder().encode(testCase.ledgerText);
      const run = (impl: typeof tsReader): string => {
        try {
          return `ok:${impl.decodeLedgerPrefix(bytes, testCase.uptoBytes)}`;
        } catch (err) {
          return `err:${(err as { code?: string }).code}`;
        }
      };
      expect(run(cjs)).toBe(run(tsReader));
    });
  }
});
