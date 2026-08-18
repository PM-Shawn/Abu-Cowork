// @vitest-environment node

/**
 * Contract test: the Electron-main fold port must agree with the renderer's
 * `foldMessageLog` on every shared fixture.
 *
 * Why this exists: the catalog (SQLite + FTS) is a projection of the very same
 * JSONL the UI renders, and the two used to be kept in sync only by a comment
 * ("mirrors dedupMessagesById"). Comments drift; a fixture replay does not.
 * See `docs/abu-message-ledger-plan.md` §3.3 — one fold spec, three consumers.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { foldMessageLog as foldTs } from '../src/core/session/messageLedger';
import { loadFoldFixtures, projectFolded } from '../src/test/foldFixtures';

const require_ = createRequire(import.meta.url);
const { foldMessageLog: foldElectron } = require_('./messageLedgerFold.cjs') as {
  foldMessageLog: (lines: readonly string[]) => {
    messages: { id?: string; content?: unknown }[];
    corruptCount: number;
    totalLines: number;
  };
};

describe('messageLedgerFold (Electron port) ↔ messageLedger (renderer)', () => {
  const fixtures = loadFoldFixtures();

  it('the fixture file is non-empty and covers the event kinds', () => {
    expect(fixtures.length).toBeGreaterThan(5);
    const allLines = fixtures.flatMap((c) => c.lines).join('\n');
    for (const kind of ['msg.put', 'msg.tomb', 'msg.truncate', 'msg.loopDrop']) {
      expect(allLines).toContain(kind);
    }
  });

  for (const testCase of fixtures) {
    it(`agrees on fixture: ${testCase.name}`, () => {
      const electron = foldElectron(testCase.lines);
      const ts = foldTs(testCase.lines);

      // Both ports must match the fixture...
      expect(projectFolded(electron.messages)).toEqual(testCase.expected.messages);
      expect(electron.corruptCount).toBe(testCase.expected.corruptCount);
      expect(electron.totalLines).toBe(testCase.expected.totalLines);

      // ...and, byte for byte, each other.
      expect(JSON.stringify(electron.messages)).toBe(JSON.stringify(ts.messages));
      expect(electron.corruptCount).toBe(ts.corruptCount);
      expect(electron.totalLines).toBe(ts.totalLines);
    });
  }
});
