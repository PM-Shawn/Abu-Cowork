import { describe, expect, it } from 'vitest';
import { projectFolded } from '@/test/foldFixtures';
import { loadLedgerReaderFixtures, snapshotTextOf } from '@/test/ledgerReaderFixtures';
import { foldMessageLog } from './messageLedger';
import { decodeLedgerPrefix, LedgerWatermarkError, projectLedger } from './ledgerReader';

const { cases, watermarkCases } = loadLedgerReaderFixtures();

/** U+FEFF, built from its code point so this file holds no invisible character. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** What a fixture's snapshot object records in its file-level `ledgerBytes` field. */
function recordedLedgerCharsOf(snapshot: unknown): number | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined;
  const recorded = (snapshot as { ledgerBytes?: unknown }).ledgerBytes;
  return typeof recorded === 'number' ? recorded : undefined;
}

describe('projectLedger', () => {
  it('covers every rule the fixture file promises', () => {
    expect(cases.length).toBeGreaterThanOrEqual(21);
    expect(cases.some((c) => c.expected.discardedWhole)).toBe(true);
    expect(cases.some((c) => c.expected.droppedIds.length > 0)).toBe(true);
    expect(cases.some((c) => c.expected.mergedIds.length > 0)).toBe(true);
    // The byte-order-mark case holds an invisible character; without it the
    // case would still pass, because its expected length is the mark-free one.
    expect(cases.some((c) => c.ledgerText.startsWith(BYTE_ORDER_MARK))).toBe(true);
  });

  for (const testCase of cases) {
    it(`fixture: ${testCase.name}`, () => {
      const projection = projectLedger({
        ledgerText: testCase.ledgerText,
        snapshotText: snapshotTextOf(testCase.snapshot),
      });
      expect(projectFolded(projection.messages)).toEqual(testCase.expected.messages);
      expect(projection.corruptCount).toBe(testCase.expected.corruptCount);
      expect(projection.totalLines).toBe(testCase.expected.totalLines);
      expect(projection.ledgerChars).toBe(testCase.expected.ledgerChars);
      expect([...projection.snapshot.merged.keys()]).toEqual(testCase.expected.mergedIds);
      expect(projection.snapshot.droppedIds).toEqual(testCase.expected.droppedIds);
      expect(projection.snapshot.discardedWhole).toBe(testCase.expected.discardedWhole);
      expect(projection.snapshot.recordedLedgerChars)
        .toBe(recordedLedgerCharsOf(testCase.snapshot));
    });
  }

  it('has fixtures on both sides of the file-level watermark field', () => {
    // Each case's own `recordedLedgerChars` is asserted in the loop above; this
    // keeps both shapes represented there — snapshots that record a length, and
    // the ones that record none (damaged file, non-number value, field absent).
    const withRecorded = cases.filter((c) => recordedLedgerCharsOf(c.snapshot) !== undefined);
    expect(withRecorded.length).toBeGreaterThanOrEqual(1);
    expect(cases.length - withRecorded.length).toBeGreaterThanOrEqual(3);
  });

  for (const testCase of cases) {
    it(`with no snapshot it equals foldMessageLog on the ledger's lines: ${testCase.name}`, () => {
      const projection = projectLedger({ ledgerText: testCase.ledgerText, snapshotText: null });
      // A leading byte-order mark is an encoding marker rather than the first
      // character of a line, so the lines the fold sees are the ones after it.
      const ledgerLines = testCase.ledgerText.startsWith(BYTE_ORDER_MARK)
        ? testCase.ledgerText.slice(BYTE_ORDER_MARK.length)
        : testCase.ledgerText;
      const folded = foldMessageLog(ledgerLines.split('\n'));
      expect(JSON.stringify(projection.messages)).toBe(JSON.stringify(folded.messages));
      expect(projection.corruptCount).toBe(folded.corruptCount);
      expect(projection.totalLines).toBe(folded.totalLines);
    });
  }
});

describe('decodeLedgerPrefix', () => {
  for (const testCase of watermarkCases) {
    it(`fixture: ${testCase.name}`, () => {
      const bytes = new TextEncoder().encode(testCase.ledgerText);
      if (testCase.expectedError) {
        let thrown: unknown;
        try {
          decodeLedgerPrefix(bytes, testCase.uptoBytes);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(LedgerWatermarkError);
        expect((thrown as LedgerWatermarkError).code).toBe(testCase.expectedError);
        expect((thrown as LedgerWatermarkError).uptoBytes).toBe(testCase.uptoBytes);
        expect((thrown as LedgerWatermarkError).fileBytes).toBe(bytes.byteLength);
      } else {
        expect(decodeLedgerPrefix(bytes, testCase.uptoBytes)).toBe(testCase.expectedText);
      }
    });
  }

  // NaN cannot be written into the fixture file, so the case that a watermark
  // is not a number at all lives here.
  it('refuses a NaN watermark', () => {
    const bytes = new TextEncoder().encode('{"id":"u1","role":"user","content":"第一条","timestamp":1}\n');
    let thrown: unknown;
    try {
      decodeLedgerPrefix(bytes, Number.NaN);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LedgerWatermarkError);
    expect((thrown as LedgerWatermarkError).code).toBe('watermark_not_at_line_end');
    expect((thrown as LedgerWatermarkError).uptoBytes).toBeNaN();
    expect((thrown as LedgerWatermarkError).fileBytes).toBe(bytes.byteLength);
  });
});
