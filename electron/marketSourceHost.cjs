'use strict';
/**
 * Markets added by address (docs/app-spec.md, 「添加市场」): an `https://` git
 * repository, a `https://github.com/<owner>/<repo>` page, or an `https://`
 * download address of a `.zip`. The main process fetches the market into
 * `~/.abu/markets/<name>/` and the renderer then reads it like any local
 * market folder; the renderer only ever hands over the address.
 *
 * - A GitHub repository is always downloaded as the zip of its default branch
 *   (`codeload.github.com/<owner>/<repo>/zip/HEAD`): most customers' computers
 *   have no git, and a pasted repository address pins no commit.
 * - Any other `https://` repository is cloned with the hardened git runner from
 *   `pluginGitHost.cjs` (scrubbed environment, no prompts, timeout, depth 1).
 * - A `.zip` address is downloaded with the same size, redirect and unpack
 *   limits as plugin archives; it must unpack to exactly one top folder.
 *
 * Every failure the user can act on carries one of three codes, which the
 * add dialog turns into a sentence: `auth_required` (the address needs a
 * login), `not_a_market` (nothing readable, or no marketplace.json there),
 * `name_taken` (another address already provides a market of that name).
 */
const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PluginGitError, assertSafeGitUrl, downloadArchiveHttps, runGit: defaultRunGit } = require('./pluginGitHost.cjs');

const MARKET_SOURCE_MISS = Symbol('market-source-miss');
const MARKETPLACE_CANDIDATES = ['.abu-plugin/marketplace.json', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];
const SOURCE_FILE = '.abu-market-source.json';
const GITHUB_REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
/** Remote markets are fetched again when opened, at most this often. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 120_000;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

class MarketSourceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MarketSourceError';
    this.code = code;
  }
}

function isHttpsUrl(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

/** How an address is fetched: `github`, `zip` or `git`. */
function classifyAddress(address) {
  if (typeof address !== 'string' || address.trim() !== address || address.length === 0) throw new MarketSourceError('address required', 'not_a_market');
  if (!isHttpsUrl(address)) throw new MarketSourceError(`address must start with https:// (${address})`, 'not_a_market');
  const github = GITHUB_REPO_RE.exec(address);
  if (github) return { kind: 'github', url: `https://codeload.github.com/${github[1]}/${github[2]}/zip/HEAD` };
  if (new URL(address).pathname.toLowerCase().endsWith('.zip')) return { kind: 'zip', url: address };
  assertSafeGitUrl(address);
  return { kind: 'git', url: address };
}

/**
 * Unpack a zip whose entries all sit under one top folder into `destDir`,
 * that folder's contents at the root. Rejects anything that could land
 * outside `destDir` and caps the unpacked size.
 */
function unpackSingleRootZip(zipBytes, destDir, fs = nodeFs) {
  const fflate = require('fflate');
  let unpacked = 0;
  let entries;
  try {
    entries = fflate.unzipSync(new Uint8Array(zipBytes), {
      filter: (info) => {
        unpacked += info.originalSize || 0;
        if (unpacked > MAX_UNPACKED_BYTES) throw new MarketSourceError(`archive unpacks to more than ${MAX_UNPACKED_BYTES} bytes`, 'not_a_market');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof MarketSourceError) throw error;
    throw new MarketSourceError(`archive could not be unpacked: ${error.message}`, 'not_a_market');
  }
  const names = Object.keys(entries);
  const roots = new Set(names.map((name) => name.split('/')[0]));
  if (names.length === 0 || roots.size !== 1) throw new MarketSourceError('archive must hold exactly one top folder', 'not_a_market');
  const prefix = `${[...roots][0]}/`;
  const root = path.resolve(destDir);
  const plan = [];
  for (const name of names) {
    if (name.includes('\0')) throw new MarketSourceError(`unsafe path in archive: ${JSON.stringify(name)}`, 'not_a_market');
    if (name.endsWith('/') || !name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    const segments = rel.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || /[\\:]/.test(segment))) {
      throw new MarketSourceError(`unsafe path in archive: ${JSON.stringify(name)}`, 'not_a_market');
    }
    const dest = path.resolve(root, rel);
    if (!dest.startsWith(root + path.sep)) throw new MarketSourceError(`unsafe path in archive: ${JSON.stringify(name)}`, 'not_a_market');
    plan.push({ name, dest });
  }
  for (const { name, dest } of plan) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entries[name]);
  }
}

/** The `name` of the marketplace.json found in `dir`. */
function marketName(dir, fs = nodeFs) {
  for (const candidate of MARKETPLACE_CANDIDATES) {
    const file = path.join(dir, candidate);
    if (!fs.existsSync(file)) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new MarketSourceError(`${candidate} is not valid JSON`, 'not_a_market'); }
    const name = raw && typeof raw === 'object' ? raw.name : undefined;
    if (typeof name !== 'string' || name.length === 0 || /[/\\\u0000-\u001f\u007f]/.test(name) || /^\.+$/.test(name)) {
      throw new MarketSourceError(`${candidate} has no usable name`, 'not_a_market');
    }
    return name;
  }
  throw new MarketSourceError('no marketplace.json at this address', 'not_a_market');
}

/** A download or clone failure, as one of the codes the user reads. */
function failureCode(error) {
  if (error instanceof MarketSourceError) return error;
  if (error && (error.status === 401 || error.status === 403)) return new MarketSourceError(error.message, 'auth_required');
  const text = error && error.message ? error.message : String(error);
  if (/could not read Username|Authentication failed|terminal prompts disabled|HTTP Basic: Access denied|returned error: 40[13]/i.test(text)) {
    return new MarketSourceError(text, 'auth_required');
  }
  return new MarketSourceError(text, 'not_a_market');
}

/**
 * @param {object} options
 * @param {string} options.marketsRoot `~/.abu/markets`
 * @param {(url: string, opts: object) => Promise<Buffer>} [options.download]
 * @param {(args: string[], opts: object) => Promise<string>} [options.runGit]
 * @param {() => number} [options.now]
 */
function createMarketSourceHost({ marketsRoot, download = downloadArchiveHttps, runGit = defaultRunGit, now = Date.now, fs = nodeFs }) {
  const root = path.resolve(marketsRoot);

  async function fetchInto(address, dir) {
    const source = classifyAddress(address);
    try {
      if (source.kind === 'git') {
        await runGit(['clone', '--depth', '1', '--', source.url, dir], { timeoutMs: GIT_TIMEOUT_MS });
        fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
        return;
      }
      const bytes = await download(source.url, { isAllowed: isHttpsUrl });
      fs.mkdirSync(dir, { recursive: true });
      unpackSingleRootZip(bytes, dir, fs);
    } catch (error) {
      throw failureCode(error);
    }
  }

  function readSource(name) {
    const file = path.join(root, name, SOURCE_FILE);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /**
   * Fetch `address` and store it as the market it names. The same address
   * fetched again replaces its copy; a different address naming a market
   * that is already there is refused.
   */
  async function add(address) {
    fs.mkdirSync(root, { recursive: true });
    const staging = path.join(root, `.staging-${crypto.randomBytes(8).toString('hex')}`);
    try {
      await fetchInto(address, staging);
      const name = marketName(staging, fs);
      const dir = path.join(root, name);
      if (fs.existsSync(dir)) {
        const existing = readSource(name);
        if (!existing || existing.address !== address) throw new MarketSourceError(`a market named ${name} already exists`, 'name_taken');
        fs.rmSync(dir, { recursive: true, force: true });
      }
      fs.writeFileSync(path.join(staging, SOURCE_FILE), JSON.stringify({ address, fetchedAt: now() }));
      fs.renameSync(staging, dir);
      return { name, dir };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Fetch a stored market again when its copy is older than an hour. Returns whether it was fetched. */
  async function refresh(name) {
    const source = readSource(name);
    if (!source || typeof source.address !== 'string') throw new MarketSourceError(`market ${name} was not added by address`, 'not_a_market');
    if (now() - source.fetchedAt < REFRESH_AFTER_MS) return { refreshed: false };
    const result = await add(source.address);
    if (result.name !== name) throw new MarketSourceError(`the address of ${name} now provides ${result.name}`, 'not_a_market');
    return { refreshed: true };
  }

  function remove(name) {
    const dir = path.resolve(root, name);
    if (!dir.startsWith(root + path.sep)) throw new MarketSourceError(`unsafe market name ${JSON.stringify(name)}`, 'not_a_market');
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }

  return { add, refresh, remove, readSource };
}

/**
 * `market_source_add` / `market_source_refresh` / `market_source_remove`.
 * Errors keep their code on a message prefix the renderer can read back
 * (`[auth_required] …`), since invoke rejections carry only the message.
 */
function marketSourceDispatch(cmd, payload, host) {
  if (!['market_source_add', 'market_source_refresh', 'market_source_remove'].includes(cmd)) return MARKET_SOURCE_MISS;
  const args = (payload && payload.args) || {};
  const run = async () => {
    if (cmd === 'market_source_add') return host.add(args.address);
    if (typeof args.name !== 'string' || args.name.length === 0) throw new MarketSourceError('market name required', 'not_a_market');
    if (cmd === 'market_source_refresh') return host.refresh(args.name);
    return host.remove(args.name);
  };
  return run().catch((error) => {
    const code = error instanceof MarketSourceError || error instanceof PluginGitError ? error.code : 'not_a_market';
    throw new Error(`[${code}] ${error.message}`);
  });
}

module.exports = {
  MARKET_SOURCE_MISS,
  MarketSourceError,
  REFRESH_AFTER_MS,
  classifyAddress,
  createMarketSourceHost,
  marketSourceDispatch,
  unpackSingleRootZip,
};
