import { describe, expect, it } from 'vitest';
import { projectFolded } from '@/test/foldFixtures';
import { loadLedgerReaderFixtures, snapshotTextOf } from '@/test/ledgerReaderFixtures';
import { foldMessageLog } from './messageLedger';
import { decodeLedgerPrefix, LedgerWatermarkError, projectLedger } from './ledgerReader';

const { cases, watermarkCases } = loadLedgerReaderFixtures();

describe('projectLedger', () => {
  it('covers every rule the fixture file promises', () => {
    expect(cases.length).toBeGreaterThanOrEqual(21);
    expect(cases.some((c) => c.expected.discardedWhole)).toBe(true);
    expect(cases.some((c) => c.expected.droppedIds.length > 0)).toBe(true);
    expect(cases.some((c) => c.expected.mergedIds.length > 0)).toBe(true);
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
    });
  }

  for (const testCase of cases) {
    it(`with no snapshot it equals foldMessageLog on the same text: ${testCase.name}`, () => {
      const projection = projectLedger({ ledgerText: testCase.ledgerText, snapshotText: null });
      const folded = foldMessageLog(testCase.ledgerText.split('\n'));
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
