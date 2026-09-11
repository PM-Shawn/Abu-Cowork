/**
 * Quarantine SLA enforcer — runs in the DEFAULT gate (not in quarantine/).
 *
 * Enforces the same four-week SLA for quarantined Vitest files and Playwright
 * specs. Spec quarantine must use a reasoned test.fixme marker; retries and
 * unreasoned skips are not quarantine mechanisms.
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
import { inspectSpecQuarantines } from '../test/specQuarantine';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUARANTINE_DIR = join(__dirname, 'quarantine');
const REPO_ROOT = join(__dirname, '..', '..');
const SPEC_DIRS = [join(REPO_ROOT, 'e2e'), join(REPO_ROOT, 'tests', 'e2e')];

// Committed fallback for local runs (CI overrides via QUARANTINE_ASOF).
const FALLBACK_ASOF = '2026-09-08';
const BASE_DATE = resolveQuarantineAsOf(process.env, FALLBACK_ASOF);
const SLA_DAYS = 28;
const SLA_MS = SLA_DAYS * 24 * 60 * 60 * 1000;

// Header pattern: // QUARANTINED: <url> (<YYYY-MM-DD>)
const QUARANTINED_HEADER = /^\/\/ QUARANTINED: (\S+) \((\d{4}-\d{2}-\d{2})\)/;

function listFilesRecursively(directory: string, predicate: (filename: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return listFilesRecursively(entryPath, predicate);
    return entry.isFile() && predicate(entry.name) ? [entryPath] : [];
  });
}

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

describe('Playwright spec quarantine SLA', () => {
  const specFiles = SPEC_DIRS.flatMap((directory) =>
    listFilesRecursively(directory, (filename) => filename.endsWith('.spec.ts')),
  );
  const quarantinedSpecs = specFiles
    .map((filePath) => ({ filePath, content: readFileSync(filePath, 'utf8') }))
    .filter(({ content }) => content.includes('QUARANTINED:'));

  if (quarantinedSpecs.length === 0) {
    it('no quarantined Playwright specs to check', () => {
      expect(true).toBe(true);
    });
    return;
  }

  for (const { filePath, content } of quarantinedSpecs) {
    const filename = filePath.slice(REPO_ROOT.length + 1);
    it(`${filename} has valid test.fixme quarantine markers within SLA`, () => {
      expect(inspectSpecQuarantines(filename, content, BASE_DATE, SLA_DAYS).length).toBeGreaterThan(0);
    });
  }
});
