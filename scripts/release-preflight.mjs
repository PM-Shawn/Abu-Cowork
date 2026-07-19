#!/usr/bin/env node
/**
 * Release preflight — fail loudly if a release isn't prepared correctly, so a
 * misconfigured release can't ship (silently degrading to the wrong language,
 * or a version mismatch). Runs as the FIRST CI gate on tag push (release.yml
 * `preflight` job, which `build` depends on) and locally via
 * `npm run release:check`.
 *
 * Checks:
 *   1. Version agrees across package.json, src-tauri/tauri.conf.json,
 *      src-tauri/Cargo.toml, src-tauri/Cargo.lock — and, when --tag is passed,
 *      matches the tag.
 *   2. CHANGELOG.md has this version's section, English only (no CJK).
 *   3. CHANGELOG.zh-CN.md has this version's section, containing Chinese (CJK).
 *
 * Pre-release tags (vX.Y.Z-rc1) skip the changelog checks — RC builds only
 * exercise signing/notarization and may have no changelog entry.
 *
 * See RELEASING.md and the Release Process in CLAUDE.md for the convention.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const tagIdx = args.indexOf('--tag');
const tagArg = tagIdx >= 0 ? args[tagIdx + 1] : null;

const errors = [];
const fail = (m) => errors.push(m);
const readOr = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

// ── 1. Version consistency ──
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const tauri = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargoToml = readFileSync('src-tauri/Cargo.toml', 'utf8');
const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8');

const versions = {
  'package.json': pkg.version,
  'src-tauri/tauri.conf.json': tauri.version,
  'src-tauri/Cargo.toml': (cargoToml.match(/^version = "([^"]+)"/m) || [])[1],
  'src-tauri/Cargo.lock': (cargoLock.match(/name = "abu"\nversion = "([^"]+)"/) || [])[1],
};

const ref = pkg.version;
for (const [file, v] of Object.entries(versions)) {
  if (v !== ref) fail(`version mismatch: ${file} = ${v ?? '(not found)'}, expected ${ref} (from package.json)`);
}

const isPrerelease = tagArg ? tagArg.includes('-') : false;
if (tagArg) {
  const base = tagArg.replace(/^v/, '').split('-')[0];
  if (base !== ref) fail(`tag ${tagArg} implies version ${base}, but package.json is ${ref}`);
}

// ── 2 & 3. Changelog sections (skipped for pre-release tags) ──
// CJK ideographs (incl. ext-A), CJK symbols/punctuation, and fullwidth forms.
const CJK = /[㐀-鿿　-〿＀-￯]/;

function section(text, ver) {
  if (!text) return null;
  const heading = `## v${ver}`;
  let idx = -1;
  let from = 0;
  // Match the exact version heading (guard against v0.3.1 matching v0.3.10).
  for (;;) {
    idx = text.indexOf(heading, from);
    if (idx < 0) return null;
    const after = text[idx + heading.length];
    if (after === undefined || ' \t\n·'.includes(after)) break;
    from = idx + heading.length;
  }
  const headEnd = text.indexOf('\n', idx);
  const next = text.indexOf('\n## v', headEnd);
  return text.slice(headEnd + 1, next < 0 ? undefined : next).trim();
}

if (!isPrerelease) {
  const en = section(readOr('CHANGELOG.md'), ref);
  const zh = section(readOr('CHANGELOG.zh-CN.md'), ref);

  if (!en) fail(`CHANGELOG.md is missing a "## v${ref}" section (the English canonical notes)`);
  else if (CJK.test(en)) fail(`CHANGELOG.md v${ref} section contains CJK text — it must be English only (Chinese goes in CHANGELOG.zh-CN.md)`);

  if (!zh) fail(`CHANGELOG.zh-CN.md is missing a "## v${ref}" section (the Chinese notes shown to zh users)`);
  else if (!CJK.test(zh)) fail(`CHANGELOG.zh-CN.md v${ref} section has no Chinese text — it must be the Chinese changelog`);
}

// ── Report ──
const label = `v${ref}${tagArg ? ` (tag ${tagArg})` : ''}${isPrerelease ? ' [pre-release: changelog checks skipped]' : ''}`;
if (errors.length) {
  console.error(`\n✗ Release preflight FAILED for ${label}:\n`);
  for (const e of errors) console.error(`  • ${e}`);
  console.error(
    '\nFix before tagging. Convention (RELEASING.md): CHANGELOG.md is English, ' +
      'CHANGELOG.zh-CN.md is Chinese, and the version must match across package.json, ' +
      'tauri.conf.json, Cargo.toml, and Cargo.lock.\n',
  );
  process.exit(1);
}
console.log(`✓ Release preflight passed for ${label}.`);
