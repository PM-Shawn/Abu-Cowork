/**
 * Quarantine SLA enforcer — runs in the DEFAULT gate (not in quarantine/).
 *
 * For every *.test.ts file in src/__tests__/quarantine/, this test:
 *   1. Asserts the file starts with a valid QUARANTINED header line.
 *   2. Asserts the date in that header is within 4 weeks of BASE_DATE.
 *
 * If any quarantined test exceeds the SLA, this gate test fails, forcing
 * the owner to either fix the test (and move it back) or delete it.
 *
 * DATE NOTE: the as-of date comes from resolveQuarantineAsOf(): CI injects
 * QUARANTINE_ASOF=YYYY-MM-DD so the window advances every run; locally the
 * committed FALLBACK_ASOF applies so the test stays deterministic (no
 * Date.now()). Bump FALLBACK_ASOF whenever you touch this file.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveQuarantineAsOf } from '../test/quarantineAsOf';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUARANTINE_DIR = join(__dirname, 'quarantine');

// Committed fallback for local runs (CI overrides via QUARANTINE_ASOF).
const FALLBACK_ASOF = '2026-09-02';
const BASE_DATE = resolveQuarantineAsOf(process.env, FALLBACK_ASOF);
const SLA_DAYS = 28;
const SLA_MS = SLA_DAYS * 24 * 60 * 60 * 1000;

// Header pattern: // QUARANTINED: <url> (<YYYY-MM-DD>)
const QUARANTINED_HEADER = /^\/\/ QUARANTINED: (\S+) \((\d{4}-\d{2}-\d{2})\)/;

describe('quarantine SLA', () => {
  // Directory may not exist on a fresh clone if all quarantined tests have been resolved
  // (git does not track empty directories). Treat missing dir the same as an empty dir.
  const quarantineFiles = existsSync(QUARANTINE_DIR)
    ? readdirSync(QUARANTINE_DIR).filter(
        (f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'),
      )
    : [];

  if (quarantineFiles.length === 0) {
    it('no quarantine files to check', () => {
      // No quarantine files — nothing to enforce.
      expect(true).toBe(true);
    });
    return;
  }

  for (const filename of quarantineFiles) {
    const filePath = join(QUARANTINE_DIR, filename);

    it(`${filename} has valid QUARANTINED header within SLA`, () => {
      const content = readFileSync(filePath, 'utf-8');
      const firstLine = content.split('\n')[0];

      expect(
        firstLine,
        `${filename}: first line must be "// QUARANTINED: <issue-url> (YYYY-MM-DD)"\n` +
          `Got: ${JSON.stringify(firstLine)}`,
      ).toMatch(QUARANTINED_HEADER);

      const match = firstLine.match(QUARANTINED_HEADER)!;
      const dateStr = match[2];
      const quarantineDate = new Date(dateStr);

      expect(
        isNaN(quarantineDate.getTime()),
        `${filename}: could not parse date "${dateStr}"`,
      ).toBe(false);

      const ageMs = BASE_DATE.getTime() - quarantineDate.getTime();
      expect(
        ageMs,
        `${filename}: quarantined on ${dateStr}, which is ${Math.ceil(ageMs / 86400000)} days before ` +
          `BASE_DATE ${BASE_DATE.toISOString().slice(0, 10)} — exceeds ${SLA_DAYS}-day SLA.\n` +
          'Fix the test and move it out of quarantine, or delete it.',
      ).toBeLessThanOrEqual(SLA_MS);
    });
  }
});
