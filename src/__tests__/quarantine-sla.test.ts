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
 * DATE NOTE: BASE_DATE is a fixed constant, not Date.now(), to avoid
 * flakiness from clock drift across CI runs. Update it when you extend
 * the SLA window (e.g., quarterly "did anyone fix these?" sweep).
 * Current window: 2026-06-30 + 28 days = expires 2026-07-28.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUARANTINE_DIR = join(__dirname, 'quarantine');

// Fixed reference date for SLA window.
// This constant must be updated if the SLA window is intentionally extended.
// Do NOT use new Date() here — that would make the test flaky (passes today, fails in 4 weeks).
const BASE_DATE = new Date('2026-06-30');
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
