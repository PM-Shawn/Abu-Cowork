import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// src/styles/index.css keeps a legacy global `.animate-in { animation: fadeIn … }` rule for
// older screens. It sits outside any cascade layer, so it beats the tw-animate utility
// wherever the bare class appears. Design-system files use state-scoped forms such as
// `data-[state=open]:animate-in`, which compile to other class names.
const COMPONENTS_DIR = path.resolve(__dirname, '..');
const SCANNED_DIRS = [
  path.join(COMPONENTS_DIR, 'ds'),
  path.join(COMPONENTS_DIR, 'design-preview'),
  path.join(COMPONENTS_DIR, 'window'),
  path.join(COMPONENTS_DIR, 'sidebar'),
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) continue;
    out.push(full);
  }
  return out.sort();
}

describe('design-system motion classes', () => {
  const files = SCANNED_DIRS.flatMap(listSourceFiles);

  it('scans the design-system and preview sources', () => {
    expect(files.some((file) => file.endsWith(path.join('ds', 'styles.ts')))).toBe(true);
    expect(files.some((file) => file.endsWith('MotionSection.tsx'))).toBe(true);
  });

  it('never uses the bare animate-in class that the legacy rule hijacks', () => {
    const offenders: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (/(^|[\s'"`])animate-in(?=[\s'"`]|$)/.test(line)) {
          offenders.push(`${path.relative(COMPONENTS_DIR, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
