/**
 * Marketplace check — every package a marketplace lists must pass the same
 * `app` / `teams/` / `minAbuVersion` validation the installer applies
 * (`electron/shared/pluginAppSpec.mjs`), plus the curation rules for an app
 * entry (`providesApp` agrees with the manifest, logos exist, referenced icons
 * exist, entry version matches the manifest for relative sources).
 *
 * Runs in CI after `verify` (`npm run market:check`) against the official
 * market shipped with the app, and locally against any market directory:
 *
 *   node scripts/validate-plugin-market.mjs [--dir <marketDir>] [--host-version <semver>]
 *
 * Remote entries (`url` / `git-subdir`) must pin a `sha`; they are fetched
 * with the same code the app uses (`electron/pluginGitHost.cjs`) into
 * `.agent/market-check/` before validation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertMinAbuVersionDeclared,
  checkMinAbuVersion,
  parseAppConfig,
  parseTeamFile,
} from '../electron/shared/pluginAppSpec.mjs';
import { PluginManifestError } from '../electron/shared/pluginManifestError.mjs';
import { packageFileExists, scanPluginPackageDir } from '../electron/shared/pluginPackageScan.mjs';

const require = createRequire(import.meta.url);
const { fetchRemoteSource, runGit } = require('../electron/pluginGitHost.cjs');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKETPLACE_CANDIDATES = ['.abu-plugin/marketplace.json', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];

/** One problem found in one entry; `field` is the package field path when known. */
export class MarketCheckFailure {
  constructor(entry, message, field) {
    this.entry = entry;
    this.message = message;
    this.field = field;
  }
  toString() {
    const prefixed = this.field && !this.message.startsWith(`${this.field}: `) ? `${this.field}: ` : '';
    return `${this.entry}: ${prefixed}${this.message}`;
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readMarketplace(marketDir) {
  for (const candidate of MARKETPLACE_CANDIDATES) {
    const file = path.join(marketDir, candidate);
    if (existsSync(file)) return { marketplace: readJson(file), file };
  }
  throw new Error(`no marketplace.json found in ${marketDir} (looked for ${MARKETPLACE_CANDIDATES.join(', ')})`);
}

/** The subset of `parseSource` (src/core/plugin/marketplace.ts) this check needs. */
function entrySource(raw) {
  if (typeof raw === 'string') return { kind: 'relative', path: raw };
  if (!raw || typeof raw !== 'object') throw new Error('source must be a string or an object');
  if (raw.source === 'local') return { kind: 'relative', path: raw.path };
  if (raw.source === 'url') return { kind: 'url', url: raw.url, sha: raw.sha };
  if (raw.source === 'git-subdir') return { kind: 'git-subdir', url: raw.url, path: raw.path, ref: raw.ref, sha: raw.sha };
  throw new Error(`unknown source kind ${JSON.stringify(raw.source)}`);
}

function insideDir(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolvePackageDir(marketDir, entry, source, stagingRoot) {
  if (source.kind === 'relative') {
    const dir = path.resolve(marketDir, source.path);
    if (!insideDir(marketDir, dir)) throw new Error(`source path escapes the marketplace directory: ${source.path}`);
    return dir;
  }
  if (!source.sha) throw new Error(`remote source must pin a sha`);
  const finalDir = path.join(stagingRoot, entry.name, source.sha);
  if (existsSync(finalDir)) return finalDir;
  mkdirSync(path.dirname(finalDir), { recursive: true });
  const tmpDir = `${finalDir}.tmp`;
  rmSync(tmpDir, { recursive: true, force: true });
  await fetchRemoteSource(source, {
    finalDir,
    tmpDir,
    runGit,
    move: async (from, to) => renameSync(from, to),
    remove: async (dir) => rmSync(dir, { recursive: true, force: true }),
    timeoutMs: 120_000,
  });
  return finalDir;
}

/** All asset paths the manifest interface and the app config reference, with the field each came from. */
function referencedAssets(manifest, app) {
  const assets = [];
  const iface = manifest.interface ?? {};
  for (const key of ['logo', 'logoDark', 'composerIcon']) if (typeof iface[key] === 'string') assets.push({ field: `interface.${key}`, path: iface[key] });
  for (const [index, shot] of (Array.isArray(iface.screenshots) ? iface.screenshots : []).entries()) assets.push({ field: `interface.screenshots[${index}]`, path: shot });
  if (!app) return assets;
  app.home.modes.items.forEach((mode, modeIndex) => {
    if (mode.icon) assets.push({ field: `app.home.modes.items[${modeIndex}].icon`, path: mode.icon });
    mode.scenes.forEach((scene, sceneIndex) => {
      if (scene.icon) assets.push({ field: `app.home.modes.items[${modeIndex}].scenes[${sceneIndex}].icon`, path: scene.icon });
    });
  });
  app.nav?.items.forEach((item, index) => {
    if (item.icon) assets.push({ field: `app.nav.items[${index}].icon`, path: item.icon });
  });
  return assets;
}

/**
 * Validate one package directory as the installer would, then apply the
 * marketplace curation rules. Returns the failures instead of throwing so a
 * run reports every entry.
 */
export function checkPackage(packageDir, entry, { hostVersion }) {
  const failures = [];
  const fail = (message, field) => failures.push(new MarketCheckFailure(entry.name, message, field));
  const catching = (fn) => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof PluginManifestError) {
        fail(error.message, error.field);
        return undefined;
      }
      throw error;
    }
  };

  const scan = catching(() => scanPluginPackageDir(packageDir));
  if (!scan) return failures;
  const manifest = scan.manifest.raw;
  if (!manifest || typeof manifest !== 'object') {
    fail('manifest must be a JSON object', scan.manifest.relPath);
    return failures;
  }
  if (manifest.name !== entry.name) fail(`manifest name "${manifest.name}" differs from the marketplace entry`, 'name');
  if (entry.source.kind === 'relative' && entry.version !== undefined && manifest.version !== entry.version) {
    fail(`entry version ${entry.version} differs from manifest version ${manifest.version}; relative sources detect updates by this field`, 'version');
  }

  const teams = [];
  for (const file of scan.teamFiles) {
    const team = catching(() => parseTeamFile(file.raw, file.id, { agentNames: scan.agentNames }));
    if (team) teams.push(team);
  }
  catching(() => assertMinAbuVersionDeclared(manifest, { hasTeams: scan.teamFiles.length > 0 }));
  const compat = catching(() => checkMinAbuVersion(manifest, hostVersion));
  if (compat && !compat.ok) fail(`requires Abu ${compat.required}, this checkout is ${hostVersion}`, 'minAbuVersion');

  const app = manifest.app === undefined ? undefined : catching(() => parseAppConfig(manifest.app, {
    teamIds: teams.map(team => team.id),
    agentNames: scan.agentNames,
    skillNames: scan.skillNames,
    mcpServerNames: scan.mcpServerNames,
  }));

  if (entry.providesApp !== undefined && typeof entry.providesApp !== 'boolean') fail('providesApp must be a boolean', 'providesApp');
  if (entry.minAbuVersion !== undefined && entry.minAbuVersion !== manifest.minAbuVersion) fail(`entry minAbuVersion ${entry.minAbuVersion} differs from manifest minAbuVersion ${manifest.minAbuVersion}`, 'minAbuVersion');
  if (entry.providesApp === true && entry.minAbuVersion === undefined) fail('an app entry must mirror the manifest minAbuVersion so older Abu versions hide it', 'minAbuVersion');
  if (entry.providesApp === true && manifest.app === undefined) fail('entry sets providesApp but the manifest has no app', 'app');
  if (entry.providesApp !== true && manifest.app !== undefined) fail('manifest has app but the entry does not set providesApp: true', 'providesApp');
  if (manifest.app !== undefined) {
    const iface = manifest.interface ?? {};
    for (const key of ['displayName', 'shortDescription', 'logo', 'logoDark']) {
      if (typeof iface[key] !== 'string' || iface[key].length === 0) fail(`an app must set interface.${key}`, `interface.${key}`);
    }
    // The listing shows the entry's own displayName, and the app itself shows
    // the manifest's. Two spellings would give the same app two names.
    if (entry.displayName === undefined) fail('an app entry must mirror interface.displayName so the listing names the app', 'displayName');
    else if (entry.displayName !== iface.displayName) fail(`entry displayName ${entry.displayName} differs from interface.displayName ${iface.displayName}`, 'displayName');
  }
  if (entry.displayName !== undefined && typeof entry.displayName !== 'string') fail('displayName must be a string', 'displayName');
  for (const asset of referencedAssets(manifest, app)) {
    if (!packageFileExists(packageDir, asset.path)) fail(`file not found in package: ${asset.path}`, asset.field);
  }
  return failures;
}

export async function checkMarket(marketDir, { hostVersion, stagingRoot = path.join(repoRoot, '.agent', 'market-check') }) {
  const { marketplace, file } = readMarketplace(marketDir);
  if (!Array.isArray(marketplace.plugins)) throw new Error(`${file}: plugins must be an array`);
  const failures = [];
  const checked = [];
  const names = new Set();
  for (const [index, raw] of marketplace.plugins.entries()) {
    const label = typeof raw?.name === 'string' ? raw.name : `plugins[${index}]`;
    if (names.has(label)) failures.push(new MarketCheckFailure(label, 'listed more than once'));
    names.add(label);
    let source;
    try {
      source = entrySource(raw.source);
    } catch (error) {
      failures.push(new MarketCheckFailure(label, error.message, 'source'));
      continue;
    }
    const entry = { name: label, displayName: raw.displayName, version: raw.version, providesApp: raw.providesApp, minAbuVersion: raw.minAbuVersion, source };
    let packageDir;
    try {
      packageDir = await resolvePackageDir(marketDir, entry, source, stagingRoot);
    } catch (error) {
      failures.push(new MarketCheckFailure(label, error.message, 'source'));
      continue;
    }
    failures.push(...checkPackage(packageDir, entry, { hostVersion }));
    checked.push({ name: label, packageDir, providesApp: entry.providesApp === true });
  }
  return { marketplace: marketplace.name, file, checked, failures };
}

function parseArgs(argv) {
  const options = { dir: path.join(repoRoot, 'builtin-plugin-market'), hostVersion: readJson(path.join(repoRoot, 'package.json')).version };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') options.dir = path.resolve(argv[++i]);
    else if (argv[i] === '--host-version') options.hostVersion = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await checkMarket(options.dir, { hostVersion: options.hostVersion });
  for (const item of result.checked) console.log(`checked ${item.name}${item.providesApp ? ' (app)' : ''} — ${path.relative(repoRoot, item.packageDir) || '.'}`);
  if (result.failures.length === 0) {
    console.log(`market "${result.marketplace}": ${result.checked.length} package(s) OK`);
    return;
  }
  for (const failure of result.failures) console.error(`✗ ${failure}`);
  console.error(`market "${result.marketplace}": ${result.failures.length} problem(s)`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
