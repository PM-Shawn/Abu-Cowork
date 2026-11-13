// What is removed from the bundled Python runtime's site-packages to save disk, and where site-packages is.
// Kept apart from setup-electron-runtimes.mjs (which runs on import) so it can be unit tested.
import fs from 'node:fs';
import path from 'node:path';

/** Test suites and sample data inside the large scientific wheels: never imported at run time. */
export const SCIENTIFIC_TEST_DIRS = [
  'pandas/tests',
  'matplotlib/tests',
  'matplotlib/mpl-data/sample_data',
  'numpy/tests',
  'numpy/_core/tests',
  'numpy/lib/tests',
  'numpy/linalg/tests',
  'numpy/fft/tests',
  'numpy/ma/tests',
  'numpy/random/tests',
  'numpy/polynomial/tests',
  'numpy/f2py/tests',
  'numpy/typing/tests',
  'numpy/testing/tests',
  'numpy/matrixlib/tests',
];

/** site-packages of an extracted runtime: Windows keeps it in Lib/, macOS and Linux in lib/python3.X/. */
export function findSitePackages(runtimeRoot) {
  const windows = path.join(runtimeRoot, 'Lib', 'site-packages');
  if (fs.existsSync(windows)) return windows;
  const lib = path.join(runtimeRoot, 'lib');
  if (fs.existsSync(lib)) {
    for (const entry of fs.readdirSync(lib).sort()) {
      const candidate = path.join(lib, entry, 'site-packages');
      if (/^python\d/.test(entry) && fs.existsSync(candidate)) return candidate;
    }
  }
  return windows;
}

/** Removes the test folders; returns how many existed. */
export function stripScientificTests(runtimeRoot) {
  const sitePackages = findSitePackages(runtimeRoot);
  let removed = 0;
  for (const relative of SCIENTIFIC_TEST_DIRS) {
    const target = path.join(sitePackages, relative);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
