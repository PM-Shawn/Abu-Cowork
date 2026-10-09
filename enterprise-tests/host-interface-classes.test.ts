import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

// Tailwind generates a class only for the files it scans, and by itself it scans this checkout.
// The overlay's interface files are compiled into the enterprise build from the sibling checkout,
// so the overlay names them in `interface-classes.css`, which the host's stylesheet imports
// through the build alias. A class written only in the overlay has a rule because of that file.
const HOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY_SRC = path.resolve(HOST, '../Abu-enterprise-modules/src');

function sources(file: string): string[] {
  const named: string[] = [];
  postcss.parse(readFileSync(file, 'utf8')).walkAtRules('source', (rule) => { named.push(rule.params); });
  return named;
}

// Every file under `directory` that can hold JSX, tests aside, relative to it.
function interfaceFiles(directory: string, base = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return interfaceFiles(full, base);
    if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.test.tsx')) return [];
    return [path.relative(base, full).split(path.sep).join('/')];
  });
}

describe('the class scan of the enterprise build', () => {
  it('reads the overlay\'s list of interface files from the host stylesheet', () => {
    const imports: string[] = [];
    postcss.parse(readFileSync(path.join(HOST, 'src/styles/index.css'), 'utf8')).walkAtRules('import', (rule) => { imports.push(rule.params); });
    expect(imports).toContain('"@enterprise-modules/interface-classes.css"');
  });

  it('names the overlay\'s interface directory and leaves its tests out', () => {
    expect(sources(path.join(OVERLAY_SRC, 'interface-classes.css'))).toEqual([
      '"./components"',
      'not "./components/**/*.test.{ts,tsx}"',
    ]);
  });

  it('covers every overlay file that can hold a class name', () => {
    const files = interfaceFiles(OVERLAY_SRC);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !file.startsWith('components/'))).toEqual([]);
  });
});
