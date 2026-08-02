/**
 * Shared test/harness helper: recursively list relative file paths under a
 * dir (sorted). Used by electron/spike/migrationVerify.cjs and
 * electron/tauriMigration.test.ts so both assert the same notion of
 * "files copied". Lives in spike/ so it stays out of the packaged app
 * (electron-builder excludes electron/spike/**).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} dir
 * @returns {string[]} relative file paths, sorted
 */
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

module.exports = { listFiles };
