/**
 * Marketplace check — every plugin and every app a marketplace lists must pass
 * the same validation Abu applies when installing or adding it
 * (`electron/shared/pluginSpec.mjs`, `electron/shared/appSpec.mjs`), plus the
 * curation rules: entry and file agree on name, version and `minAbuVersion`,
 * logos and referenced icons exist, and every `plugin:` reference in an app
 * names a team, expert, skill or connector the listed plugin really ships.
 *
 * Runs in CI after `verify` (`npm run market:check`) against the official
 * market shipped with the app, and locally against any market directory:
 *
 *   node scripts/validate-plugin-market.mjs [--dir <marketDir>] [--host-version <semver>]
 *
 * An app's plugins are looked up in the checked market first, then in the
 * official market. Remote entries (`url` / `git-subdir`) must pin a `sha`; they
 * are fetched with the same code the app uses (`electron/pluginGitHost.cjs`)
 * into `.agent/market-check/` before validation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import {
  assertMinAbuVersionDeclared,
  checkMinAbuVersion,
  parseTeamFile,
} from '../electron/shared/pluginSpec.mjs';
import { APP_FILE_PATH, appRuns, parseAppFile, splitRunTarget } from '../electron/shared/appSpec.mjs';
import { PluginManifestError } from '../electron/shared/pluginManifestError.mjs';
import { packageFileExists, scanPluginPackageDir } from '../electron/shared/pluginPackageScan.mjs';

const require = createRequire(import.meta.url);
const { fetchRemoteSource, runGit } = require('../electron/pluginGitHost.cjs');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const officialMarketDir = path.join(repoRoot, 'builtin-plugin-market');
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

async function resolveEntryDir(marketDir, name, source, stagingRoot) {
  if (source.kind === 'relative') {
    const dir = path.resolve(marketDir, source.path);
    if (!insideDir(marketDir, dir)) throw new Error(`source path escapes the marketplace directory: ${source.path}`);
    return dir;
  }
  if (!source.sha) throw new Error(`remote source must pin a sha`);
  const finalDir = path.join(stagingRoot, name, source.sha);
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

function collector(entryName) {
  const failures = [];
  const fail = (message, field) => failures.push(new MarketCheckFailure(entryName, message, field));
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
  return { failures, fail, catching };
}

/** Asset paths a plugin manifest's interface references, with the field each came from. */
function pluginAssets(manifest) {
  const assets = [];
  const iface = manifest.interface ?? {};
  for (const key of ['logo', 'logoDark', 'composerIcon']) if (typeof iface[key] === 'string') assets.push({ field: `interface.${key}`, path: iface[key] });
  for (const [index, shot] of (Array.isArray(iface.screenshots) ? iface.screenshots : []).entries()) assets.push({ field: `interface.screenshots[${index}]`, path: shot });
  return assets;
}

/** Asset paths an app references: its logos, and the icons of its modes, scenes and nav items. */
function appAssets(app) {
  const assets = [];
  for (const key of ['logo', 'logoDark']) if (app.interface[key]) assets.push({ field: `interface.${key}`, path: app.interface[key] });
  app.config.home.modes.items.forEach((mode, modeIndex) => {
    if (mode.icon) assets.push({ field: `home.modes.items[${modeIndex}].icon`, path: mode.icon });
    mode.scenes.forEach((scene, sceneIndex) => {
      if (scene.icon) assets.push({ field: `home.modes.items[${modeIndex}].scenes[${sceneIndex}].icon`, path: scene.icon });
    });
  });
  app.config.nav?.items.forEach((item, index) => {
    if (item.icon) assets.push({ field: `nav.items[${index}].icon`, path: item.icon });
  });
  return assets;
}

/**
 * Validate one plugin package as the installer would, then apply the
 * marketplace curation rules. Returns the failures and, when the package
 * reads, what it ships (for the apps that reference it).
 */
export function checkPackage(packageDir, entry, { hostVersion }) {
  const { failures, fail, catching } = collector(entry.name);
  const scan = catching(() => scanPluginPackageDir(packageDir));
  if (!scan) return { failures };
  const manifest = scan.manifest.raw;
  if (!manifest || typeof manifest !== 'object') {
    fail('manifest must be a JSON object', scan.manifest.relPath);
    return { failures };
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
  if (entry.minAbuVersion !== undefined && entry.minAbuVersion !== manifest.minAbuVersion) fail(`entry minAbuVersion ${entry.minAbuVersion} differs from manifest minAbuVersion ${manifest.minAbuVersion}`, 'minAbuVersion');
  for (const asset of pluginAssets(manifest)) {
    if (!packageFileExists(packageDir, asset.path)) fail(`file not found in package: ${asset.path}`, asset.field);
  }
  return {
    failures,
    ships: {
      teamIds: new Set(teams.map(team => team.id)),
      agentNames: new Set(scan.agentNames),
      skillNames: new Set(scan.skillNames),
      mcpServerNames: new Set(scan.mcpServerNames),
    },
  };
}

/**
 * Validate one app directory as the add step would, then check that every
 * `plugin:` reference names something the plugin ships. `pluginsByName` maps a
 * plugin name to what it ships, or is missing the name when no checked market
 * lists it.
 */
export function checkApp(appDir, entry, { hostVersion, pluginsByName }) {
  const { failures, fail, catching } = collector(`app ${entry.name}`);
  const file = path.join(appDir, APP_FILE_PATH);
  if (!existsSync(file)) {
    fail(`${APP_FILE_PATH} not found`, APP_FILE_PATH);
    return failures;
  }
  let raw;
  try {
    raw = readJson(file);
  } catch {
    fail('is not valid JSON', APP_FILE_PATH);
    return failures;
  }
  const app = catching(() => parseAppFile(raw));
  if (!app) return failures;
  if (app.name !== entry.name) fail(`app name "${app.name}" differs from the marketplace entry`, 'name');
  for (const key of ['version', 'minAbuVersion']) {
    if (entry[key] !== undefined && entry[key] !== app[key]) fail(`entry ${key} ${entry[key]} differs from app.json ${key} ${app[key]}`, key);
  }
  if (semver.lt(hostVersion, app.minAbuVersion)) fail(`requires Abu ${app.minAbuVersion}, this checkout is ${hostVersion}`, 'minAbuVersion');
  for (const key of ['logo', 'logoDark']) {
    if (!app.interface[key]) fail(`a listed app must set interface.${key}`, `interface.${key}`);
  }
  for (const asset of appAssets(app)) {
    if (!packageFileExists(appDir, asset.path)) fail(`file not found in app: ${asset.path}`, asset.field);
  }
  app.plugins.forEach((name, index) => {
    if (!pluginsByName.has(name)) fail(`plugin "${name}" is not listed in this market or the official market`, `plugins[${index}]`);
  });
  const shipsKey = { team: 'teamIds', expert: 'agentNames', skill: 'skillNames' };
  for (const { field, run } of appRuns(app.config)) {
    for (const kind of ['team', 'expert', 'skill']) {
      if (run[kind] === undefined) continue;
      const target = splitRunTarget(kind, run[kind]);
      if (target?.origin !== 'plugin') continue;
      const ships = pluginsByName.get(target.plugin);
      if (ships && !ships[shipsKey[kind]].has(target.id)) fail(`plugin "${target.plugin}" does not ship ${kind} "${target.id}"`, `${field}.${kind}`);
    }
  }
  (app.config.requiredConnectors ?? []).forEach((value, index) => {
    const slash = value.indexOf('/');
    const ships = pluginsByName.get(value.slice(0, slash));
    if (ships && !ships.mcpServerNames.has(value.slice(slash + 1))) fail(`plugin "${value.slice(0, slash)}" does not declare connector "${value.slice(slash + 1)}"`, `requiredConnectors[${index}]`);
  });
  return failures;
}

async function checkPlugins(marketDir, marketplace, { hostVersion, stagingRoot }) {
  const failures = [];
  const checked = [];
  const shipsByName = new Map();
  const names = new Set();
  for (const [index, raw] of (marketplace.plugins ?? []).entries()) {
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
    const entry = { name: label, version: raw.version, minAbuVersion: raw.minAbuVersion, source };
    let packageDir;
    try {
      packageDir = await resolveEntryDir(marketDir, label, source, stagingRoot);
    } catch (error) {
      failures.push(new MarketCheckFailure(label, error.message, 'source'));
      continue;
    }
    const result = checkPackage(packageDir, entry, { hostVersion });
    failures.push(...result.failures);
    if (result.ships) shipsByName.set(label, result.ships);
    checked.push({ kind: 'plugin', name: label, dir: packageDir });
  }
  return { failures, checked, shipsByName };
}

export async function checkMarket(marketDir, { hostVersion, stagingRoot = path.join(repoRoot, '.agent', 'market-check') }) {
  const { marketplace, file } = readMarketplace(marketDir);
  if (marketplace.plugins !== undefined && !Array.isArray(marketplace.plugins)) throw new Error(`${file}: plugins must be an array`);
  if (marketplace.apps !== undefined && !Array.isArray(marketplace.apps)) throw new Error(`${file}: apps must be an array`);
  const own = await checkPlugins(marketDir, marketplace, { hostVersion, stagingRoot });
  const failures = [...own.failures];
  const checked = [...own.checked];
  const pluginsByName = new Map(own.shipsByName);
  if ((marketplace.apps ?? []).length > 0 && path.resolve(marketDir) !== officialMarketDir) {
    const official = await checkPlugins(officialMarketDir, readMarketplace(officialMarketDir).marketplace, { hostVersion, stagingRoot });
    for (const [name, ships] of official.shipsByName) if (!pluginsByName.has(name)) pluginsByName.set(name, ships);
  }
  const appNames = new Set();
  for (const [index, raw] of (marketplace.apps ?? []).entries()) {
    const label = typeof raw?.name === 'string' ? raw.name : `apps[${index}]`;
    if (appNames.has(label)) failures.push(new MarketCheckFailure(`app ${label}`, 'listed more than once'));
    appNames.add(label);
    let source;
    try {
      source = entrySource(raw.source);
    } catch (error) {
      failures.push(new MarketCheckFailure(`app ${label}`, error.message, 'source'));
      continue;
    }
    if (source.kind !== 'relative') {
      for (const key of ['version', 'description', 'minAbuVersion']) {
        if (typeof raw[key] !== 'string') failures.push(new MarketCheckFailure(`app ${label}`, `a remote app entry must state ${key}`, key));
      }
    }
    let appDir;
    try {
      appDir = await resolveEntryDir(marketDir, label, source, stagingRoot);
    } catch (error) {
      failures.push(new MarketCheckFailure(`app ${label}`, error.message, 'source'));
      continue;
    }
    failures.push(...checkApp(appDir, { name: label, version: raw.version, minAbuVersion: raw.minAbuVersion }, { hostVersion, pluginsByName }));
    checked.push({ kind: 'app', name: label, dir: appDir });
  }
  return { marketplace: marketplace.name, file, checked, failures };
}

function parseArgs(argv) {
  const options = { dir: officialMarketDir, hostVersion: readJson(path.join(repoRoot, 'package.json')).version };
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
  for (const item of result.checked) console.log(`checked ${item.kind} ${item.name} — ${path.relative(repoRoot, item.dir) || '.'}`);
  if (result.failures.length === 0) {
    console.log(`market "${result.marketplace}": ${result.checked.length} entr${result.checked.length === 1 ? 'y' : 'ies'} OK`);
    return;
  }
  for (const failure of result.failures) console.error(`✗ ${failure}`);
  console.error(`market "${result.marketplace}": ${result.failures.length} problem(s)`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
