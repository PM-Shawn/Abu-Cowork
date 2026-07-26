/**
 * Refresh the dmg's sha512/size in release-electron/latest-mac.yml and
 * regenerate its blockmap, after `xcrun stapler staple` has rewritten the
 * dmg bytes (electron-builder computed both BEFORE stapling, so they no
 * longer match the shipped artifact).
 *
 * The zip entry (which electron-updater actually consumes on macOS — the
 * top-level `path`/`sha512` point at it) is untouched by stapling and stays
 * valid; only the dmg row needs the refresh.
 *
 * Run from the repo root, after the staple step:  node scripts/electron-refresh-dmg-hash.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

const DIR = 'release-electron';
const ymlPath = path.join(DIR, 'latest-mac.yml');

const dmgName = fs.readdirSync(DIR).find((f) => f.endsWith('.dmg'));
if (!dmgName) throw new Error(`no .dmg found in ${DIR}/`);
const dmgPath = path.join(DIR, dmgName);

// Same routine electron-builder itself runs at pack time (pure JS in v26):
// writes `${dmgPath}.blockmap` and returns the file's fresh sha512 + size.
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js');
const updateInfo = await buildBlockMap(dmgPath, 'gzip', `${dmgPath}.blockmap`);

const yaml = require('js-yaml');
const doc = yaml.load(fs.readFileSync(ymlPath, 'utf8'));
const dmgEntry = (doc.files ?? []).find((f) => f.url === dmgName);
if (!dmgEntry) throw new Error(`no entry for ${dmgName} in ${ymlPath}`);
const before = { sha512: dmgEntry.sha512, size: dmgEntry.size };
dmgEntry.sha512 = updateInfo.sha512;
dmgEntry.size = updateInfo.size;
fs.writeFileSync(ymlPath, yaml.dump(doc, { lineWidth: -1 }));

console.log(`[refresh-dmg-hash] ${dmgName}`);
console.log(`  sha512: ${before.sha512} -> ${updateInfo.sha512}`);
console.log(`  size:   ${before.size} -> ${updateInfo.size}`);
