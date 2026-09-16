'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { convertSingleFileAgent, renderAgentMd, BUILTIN_AGENT_NAMES } = require('./shared/pluginAgentFormat.mjs');
const { assertAllowed: defaultAssertAllowed } = require('./fsHost.cjs');
const { mutate: defaultMutate } = require('./pluginOperationWorker.cjs');
const { pluginGitDispatch } = require('./pluginGitHost.cjs');

const PLUGIN_SNAPSHOT_CHANNEL = 'abu:plugin-snapshot';
const MARKET_FILES = ['.abu-plugin/marketplace.json', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];
const MANIFEST_FILES = ['.abu-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);
const TTL = 30 * 60 * 1000;

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plugin snapshot: invalid request');
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Plugin snapshot: unsupported request field');
}

function segment(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.trim() !== value
    || /[/\\\x00-\x1f\x7f<>:"|?*]/.test(value) || /[. ]$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error('Plugin snapshot: unsafe identity/path segment');
  }
  return value;
}

function within(root, target) {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Plugin snapshot: path outside package');
}

function digest(tree) {
  const hash = crypto.createHash('sha256');
  for (const [name, bytes] of [...tree].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    hash.update(JSON.stringify([name, bytes === null ? 'directory' : bytes.length]));
    if (bytes !== null) hash.update(bytes);
  }
  return hash.digest('hex');
}

/** Main owns snapshot bytes and target identity. Renderer holds only a sender-bound token. */
function createPluginSnapshotHost({
  home, fs = nodeFs.promises, mutate = defaultMutate, assertAllowed = defaultAssertAllowed,
  randomId = () => crypto.randomBytes(24).toString('hex'), now = Date.now,
  fetchRemote = async (source, destDir) => pluginGitDispatch('plugin_git_fetch', { args: { source, destDir } }, { packagesRoot: path.resolve(home, '.abu', 'plugin-packages') }),
  maxBytes = 200 * 1024 * 1024, maxFiles = 10000, maxSnapshots = 4,
} = {}) {
  const records = new Map();
  const senders = new WeakSet();
  const root = path.resolve(home, '.abu', 'plugin-prepared');
  const packages = path.resolve(home, '.abu', 'plugin-packages');
  let queue = Promise.resolve();
  let preparedRootReady = false;
  // All windows share one coordinator. This serializes snapshot operations,
  // not the legacy installed.json transaction (the next implementation batch).
  const serial = fn => {
    const pending = queue.then(fn);
    queue = pending.catch(() => {});
    return pending;
  };

  async function realDirectory(dir) {
    const stats = await fs.lstat(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Plugin snapshot: directory/link refused');
    const canonical = await fs.realpath(dir);
    const after = await fs.lstat(dir);
    if (after.isSymbolicLink() || after.ino !== stats.ino || after.dev !== stats.dev) throw new Error('Plugin snapshot: directory changed');
    return canonical;
  }

  async function ownedDirectory(dir, create = false) {
    // Walk from the real user home; do not let a linked .abu/packages parent
    // redirect writes or cleanup into another part of the filesystem.
    const base = await fs.realpath(home);
    const lexicalHome = path.resolve(home);
    const relativeToHome = path.relative(lexicalHome, dir);
    const isLexical = relativeToHome !== '..' && !relativeToHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToHome);
    const relative = isLexical ? relativeToHome : path.relative(base, dir);
    within(base, path.resolve(base, relative));
    let current = base;
    for (const name of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, name);
      if (create) { try { await fs.mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
      const canonical = await realDirectory(current);
      if (canonical !== current) throw new Error('Plugin snapshot: directory/link outside owned path');
    }
    return current;
  }
  const ensureDirectory = async dir => {
    const canonicalHome = await fs.realpath(home);
    const identity = await fs.lstat(canonicalHome);
    const relative = path.relative(path.resolve(home), dir);
    within(path.resolve(home), dir);
    await mutate({ home: canonicalHome, identity: { ino: identity.ino, dev: identity.dev },
      parent: relative.split(path.sep).filter(Boolean), action: 'ensure' });
    return ownedDirectory(dir);
  };

  async function readOwnedFile(base, file, limit) {
    within(base, file);
    const before = await fs.lstat(file);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) throw new Error('Plugin snapshot: file/link refused');
    if (before.size > limit) throw new Error('Plugin snapshot: package size limit exceeded');
    within(base, await fs.realpath(file));
    const handle = await fs.open(file, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW || 0) | (nodeFs.constants.O_NONBLOCK || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('Plugin snapshot: file changed while reading');
      // Allocate at most the prechecked file size. readFile() can allocate
      // unboundedly if a writer grows the file after fstat.
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      within(base, await fs.realpath(file));
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Plugin snapshot: file changed while reading');
      return Buffer.from(bytes);
    } finally { await handle.close(); }
  }

  async function capture(dir, allowedRoot) {
    const base = await realDirectory(dir);
    within(allowedRoot, base);
    const tree = new Map(); const skippedSymlinks = [];
    let total = 0; let count = 0;
    async function walk(current, relative, depth) {
      if (depth > 64) throw new Error('Plugin snapshot: directory depth limit exceeded');
      const original = await fs.lstat(current);
      const canonical = await realDirectory(current);
      within(base, canonical);
      for (const name of (await fs.readdir(current)).sort()) {
        if (SKIP.has(name)) continue;
        // Dirent names may be legal on one platform but destructive on another.
        segment(name);
        if (++count > maxFiles) throw new Error('Plugin snapshot: file count limit exceeded');
        const file = path.join(current, name);
        const rel = relative ? `${relative}/${name}` : name;
        const stats = await fs.lstat(file);
        if (stats.isSymbolicLink()) { skippedSymlinks.push(rel); continue; }
        if (stats.isDirectory()) {
          tree.set(rel, null);
          await walk(file, rel, depth + 1);
        } else if (stats.isFile()) {
          const bytes = await readOwnedFile(base, file, Math.min(32 * 1024 * 1024, maxBytes - total));
          total += bytes.length;
          tree.set(rel, bytes);
        }
      }
      const after = await fs.lstat(current);
      if (after.isSymbolicLink() || after.ino !== original.ino || after.dev !== original.dev) throw new Error('Plugin snapshot: directory changed while reading');
    }
    await walk(base, '', 0);
    return { tree, total, skippedSymlinks };
  }

  async function writeTree(dir, tree, create = true) {
    if (create) await fs.mkdir(dir);
    for (const [relative, bytes] of tree) {
      const target = path.join(dir, ...relative.split('/'));
      if (bytes === null) await fs.mkdir(target);
      else await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
  }

  async function clean(record) {
    // Paths come from this host, never from release requests or a disk journal.
    await ownedDirectory(record.dir);
    await fs.rm(record.dir, { recursive: true, force: true });
    records.delete(record.token);
  }

  async function prune() {
    for (const record of records.values()) {
      if (record.expiresAt <= now() || record.sender.isDestroyed?.()) await clean(record);
    }
  }

  async function lookup(sender, request) {
    fields(request, ['token']);
    if (typeof request.token !== 'string') throw new Error('Plugin snapshot: invalid token');
    const record = records.get(request.token);
    if (!record) throw new Error('Plugin snapshot: token unavailable; prepare again');
    if (record.sender !== sender) throw new Error('Plugin snapshot: token belongs to another sender');
    if (record.expiresAt <= now()) { await clean(record); throw new Error('Plugin snapshot: token expired; prepare again'); }
    return record;
  }

  async function validateRecord(record) {
    if (record.consumed) throw new Error('Plugin snapshot: token already consumed; prepare again');
    const canonical = await ownedDirectory(record.packageDir);
    const actual = await capture(canonical, canonical);
    if (actual.skippedSymlinks.length || digest(actual.tree) !== record.checksum) throw new Error('Plugin snapshot: preview changed; prepare again');
  }

  async function initializePreparedRoot() {
    await ensureDirectory(root);
    if (!preparedRootReady) {
      // The app enforces a single instance per profile. Tokens are session
      // capabilities, so leftovers from an earlier process cannot be consumed.
      for (const name of await fs.readdir(root)) {
        if (!/^[a-f0-9]{48}$/.test(name)) continue;
        const leftover = path.join(root, name);
        await ownedDirectory(leftover);
        await fs.rm(leftover, { recursive: true, force: true });
      }
      preparedRootReady = true;
    }
  }

  async function registerSender(sender) {
    if (!sender || sender.isDestroyed?.()) throw new Error('Plugin snapshot: sender unavailable');
    if (!senders.has(sender)) {
      senders.add(sender);
      const releaseSender = () => { void serial(async () => {
        for (const r of records.values()) if (r.sender === sender) await clean(r);
      }).catch(() => {}); };
      sender.once?.('destroyed', releaseSender);
      sender.on?.('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) releaseSender();
      });
    }
    await prune();
    if (records.size >= maxSnapshots) throw new Error('Plugin snapshot: pending snapshot limit reached');
  }

  const prepare = (sender, request) => serial(async () => {
    fields(request, ['marketplaceDir', 'marketplaceName', 'entryName']);
    segment(request.marketplaceName); segment(request.entryName);
    if (typeof request.marketplaceDir !== 'string' || !path.isAbsolute(request.marketplaceDir) || request.marketplaceDir.includes('\0')) throw new Error('Plugin snapshot: invalid marketplace path');
    await registerSender(sender);
    const market = await realDirectory(assertAllowed(request.marketplaceDir));
    let listing;
    for (const candidate of MARKET_FILES) {
      try {
        const bytes = await readOwnedFile(market, path.join(market, candidate), 2 * 1024 * 1024);
        listing = JSON.parse(bytes.toString('utf8')); break;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (listing?.name !== request.marketplaceName) throw new Error('Plugin snapshot: marketplace identity changed; reload the marketplace');
    const matches = Array.isArray(listing?.plugins) ? listing.plugins.filter(p => p?.name === request.entryName) : [];
    if (matches.length !== 1) throw new Error('Plugin snapshot: marketplace entry missing or ambiguous');
    const raw = matches[0].source;
    let source;
    if (typeof raw === 'string') source = { kind: 'relative', path: raw };
    else if (raw?.source === 'local') source = { kind: 'relative', path: raw.path };
    else if (raw?.source === 'url' || raw?.source === 'git-subdir') source = { ...raw, kind: raw.source };
    else throw new Error('Plugin snapshot: unsupported source');
    await initializePreparedRoot();
    const token = randomId();
    segment(token);
    const dir = path.join(root, token);
    await fs.mkdir(dir);
    let remoteDir;
    try {
      let sourceDir;
      if (source.kind === 'relative') {
        if (typeof source.path !== 'string' || !source.path || /[\\:\x00-\x1f]/.test(source.path) || path.isAbsolute(source.path)) throw new Error('Plugin snapshot: invalid source path');
        const segments = source.path.split('/').filter(p => p && p !== '.');
        if (segments.includes('..')) throw new Error('Plugin snapshot: source path outside marketplace');
        sourceDir = market;
        for (const name of segments) { segment(name); sourceDir = path.join(sourceDir, name); await realDirectory(sourceDir); }
      } else {
        // The existing privileged fetcher verifies URL/SHA and containment.
        const dest = path.join(packages, request.marketplaceName, request.entryName, '_remote', token);
        await ensureDirectory(path.dirname(dest));
        remoteDir = dest;
        const fetched = await fetchRemote(source, dest);
        sourceDir = dest;
        if (path.resolve(fetched.destDir) !== dest) throw new Error('Plugin snapshot: unexpected remote destination');
      }
      const captured = await capture(sourceDir, source.kind === 'relative' ? market : await ownedDirectory(packages));
      if (remoteDir) {
        await ownedDirectory(path.dirname(remoteDir));
        await fs.rm(remoteDir, { recursive: true, force: true });
        remoteDir = undefined;
      }
      if (captured.total + [...records.values()].reduce((sum, r) => sum + r.total, 0) > maxBytes) throw new Error('Plugin snapshot: total size limit exceeded');
      const manifestBytes = MANIFEST_FILES.map(name => captured.tree.get(name)).find(bytes => bytes !== undefined);
      if (!Buffer.isBuffer(manifestBytes)) throw new Error('Plugin snapshot: manifest missing');
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (manifest.name !== request.entryName) throw new Error('Plugin snapshot: package identity does not match marketplace');
      const version = segment(manifest.version === undefined ? '0.0.0' : manifest.version);
      const packageDir = path.join(dir, 'payload');
      await writeTree(packageDir, captured.tree);
      if (sender.isDestroyed?.()) throw new Error('Plugin snapshot: sender unavailable');
      const record = { ...captured, token, dir, packageDir, sender, source, sourceDir,
        marketplaceName: request.marketplaceName, name: request.entryName, version,
        previousNames: Object.keys(listing.renames ?? {}).filter(name => {
          const visited = new Set(); let current = name;
          while (typeof listing.renames?.[current] === 'string' && !visited.has(current) && visited.size < 64) {
            visited.add(current); current = listing.renames[current];
          }
          return current === request.entryName && !visited.has(current);
        }),
        checksum: digest(captured.tree), expiresAt: now() + TTL, consumed: false };
      records.set(token, record);
      return { token, packageDir, sourceDir, checksum: record.checksum, source, version, skippedSymlinks: captured.skippedSymlinks };
    } catch (error) {
      await ownedDirectory(dir);
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    } finally {
      if (remoteDir) {
        await ownedDirectory(path.dirname(remoteDir));
        await fs.rm(remoteDir, { recursive: true, force: true });
      }
    }
  });

  // Internal only: the author service derives this path from its durable record.
  const prepareAuthored = (sender, request) => serial(async () => {
    if (!/^[a-f0-9]{32}$/.test(request.authoringId) || request.marketplaceName !== `author-${request.authoringId}`
      || ![path.resolve(home, 'Abu Plugins', request.authoringId), path.join(await fs.realpath(home), 'Abu Plugins', request.authoringId)].includes(path.resolve(request.sourceDir))) throw new Error('Plugin author: invalid source identity');
    await registerSender(sender);
    const sourceDir = await ownedDirectory(request.sourceDir);
    const captured = await capture(sourceDir, sourceDir);
    if (captured.total + [...records.values()].reduce((sum, r) => sum + r.total, 0) > maxBytes) throw new Error('Plugin snapshot: total size limit exceeded');
    const bytes = MANIFEST_FILES.map(name => captured.tree.get(name)).find(value => value !== undefined);
    if (!Buffer.isBuffer(bytes)) throw new Error('Plugin snapshot: manifest missing');
    const manifest = JSON.parse(bytes.toString('utf8'));
    const name = segment(manifest.name);
    if (request.boundName && name !== request.boundName) throw new Error('Plugin author: package name is bound; keep the original name when editing');
    const version = segment(manifest.version === undefined ? '0.0.0' : manifest.version);
    if (manifest.description !== undefined && (typeof manifest.description !== 'string' || manifest.description.length > 2048)) throw new Error('Plugin author: invalid description');
    const token = segment(randomId());
    const dir = path.join(root, token);
    const packageDir = path.join(dir, 'payload');
    await initializePreparedRoot();
    const parent = await ownedDirectory(root);
    await publishTree(parent, token, `.incoming-${token}`, new Map([['payload', null], ...[...captured.tree].map(([rel, data]) => [`payload/${rel}`, data])]));
    const source = { kind: 'relative', path: '.' };
    const record = { ...captured, token, dir, packageDir, sender, source, sourceDir, name, version,
      marketplaceName: request.marketplaceName, authoringId: request.authoringId, description: manifest.description ?? '',
      checksum: digest(captured.tree), expiresAt: now() + TTL, consumed: false };
    records.set(token, record);
    return { token, packageDir, sourceDir, checksum: record.checksum, source, version,
      name, description: manifest.description ?? '', authoringId: request.authoringId, skippedSymlinks: captured.skippedSymlinks };
  });

  const validate = (sender, request) => serial(async () => { await validateRecord(await lookup(sender, request)); return { valid: true }; });
  // Disclosure parsers read this immutable tree, never the writable disk copy.
  // Listing metadata separately bounds each IPC read to one captured file.
  const inspect = (sender, request) => serial(async () => {
    const record = await lookup(sender, request);
    if (record.consumed) throw new Error('Plugin snapshot: token already consumed');
    return [...record.tree].map(([name, bytes]) => ({ path: name, isDirectory: bytes === null }));
  });
  const read = (sender, request) => serial(async () => {
    fields(request, ['token', 'path']);
    const record = await lookup(sender, { token: request.token });
    if (record.consumed) throw new Error('Plugin snapshot: token already consumed');
    const bytes = record.tree.get(request.path);
    if (!Buffer.isBuffer(bytes)) throw new Error('Plugin snapshot: file unavailable');
    return bytes.toString('utf8');
  });
  const release = (sender, request) => serial(async () => {
    fields(request, ['token']);
    if (!records.has(request.token)) return { released: false };
    const record = await lookup(sender, request);
    await clean(record);
    return { released: true };
  });
  const materialize = (sender, request) => serial(async () => {
    const record = await lookup(sender, request);
    await validateRecord(record);
    const parent = await ensureDirectory(path.join(packages, record.marketplaceName, record.name));
    await publishTree(parent, record.version, `.incoming-${record.token}`, record.tree);
    record.consumed = true;
    return { targetDir: path.join(packages, record.marketplaceName, record.name, record.version), checksum: record.checksum };
  });
  async function publishTree(parent, name, temp, tree) {
    const canonicalHome = await fs.realpath(home);
    const identity = await fs.lstat(canonicalHome);
    const parentIdentity = await fs.lstat(parent);
    await mutate({ home: canonicalHome, identity: { ino: identity.ino, dev: identity.dev },
      parent: path.relative(canonicalHome, parent).split(path.sep),
      parentIdentity: { ino: parentIdentity.ino, dev: parentIdentity.dev },
      action: 'tree', to: name, temp,
      tree: [...tree].map(([relative, bytes]) => [relative, bytes === null ? null : bytes.toString('base64')]) });
    await ownedDirectory(parent);
  }
  function agentTrees(record, names) {
    if (!Array.isArray(names) || new Set(names).size !== names.length) throw new Error('Plugin snapshot: invalid agent selection');
    const candidates = [];
    for (const [relative, bytes] of record.tree) {
      if (!Buffer.isBuffer(bytes)) continue;
      const parts = relative.split('/');
      const folder = parts.length === 3 && parts[0] === 'agents' && parts[2] === 'AGENT.md';
      const single = parts.length === 2 && parts[0] === 'agents' && /\.md$/i.test(parts[1]);
      if (!folder && !single) continue;
      const converted = convertSingleFileAgent(bytes.toString('utf8'), folder ? parts[1] : parts[1].slice(0, -3));
      candidates.push({ relative, folder: folder ? `agents/${parts[1]}/` : null, converted });
    }
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    candidates.sort((a, b) => compare(a.converted.name, b.converted.name) || compare(a.relative, b.relative));
    return new Map(names.map(name => {
      segment(name);
      if (name.startsWith('.abu-plugin-') || BUILTIN_AGENT_NAMES.includes(name)) throw new Error('Plugin snapshot: reserved agent name');
      const candidate = candidates.find(item => item.converted.name === name);
      if (!candidate) throw new Error('Plugin snapshot: agent not in approved package');
      const tree = new Map();
      if (candidate.folder) {
        for (const [relative, bytes] of record.tree) {
          if (relative.startsWith(candidate.folder)) tree.set(relative.slice(candidate.folder.length), bytes);
        }
      }
      tree.set('AGENT.md', Buffer.from(renderAgentMd(candidate.converted, { pluginKey: `${record.name}@${record.marketplaceName}` })));
      return [name, tree];
    }));
  }
  // Only the operation coordinator calls these methods. Renderer cannot choose
  // paths, agent bytes, provenance, or bypass the confirmed memory snapshot.
  const materializeAgents = (sender, request, names) => serial(async () => {
    const record = await lookup(sender, request);
    if (!record.consumed) throw new Error('Plugin snapshot: package not materialized');
    const trees = agentTrees(record, names);
    if (!trees.size) return [];
    const parent = await ensureDirectory(path.resolve(home, '.abu', 'agents'));
    let index = 0;
    for (const [name, tree] of trees) {
      await publishTree(parent, name, `.abu-plugin-retired-${record.token}-${index++}`, tree);
    }
    return [...trees.keys()];
  });
  const verifyInstalled = (sender, request, names) => serial(async () => {
    const record = await lookup(sender, request);
    if (!record.consumed) throw new Error('Plugin snapshot: package not materialized');
    const installed = await ownedDirectory(path.join(packages, record.marketplaceName, record.name, record.version));
    const actual = await capture(installed, installed);
    if (actual.skippedSymlinks.length || digest(actual.tree) !== record.checksum) throw new Error('Plugin snapshot: installed package changed');
    for (const [name, expected] of agentTrees(record, names)) {
      const dir = await ownedDirectory(path.resolve(home, '.abu', 'agents', name));
      const actualAgent = await capture(dir, dir);
      if (actualAgent.skippedSymlinks.length || digest(actualAgent.tree) !== digest(expected)) throw new Error('Plugin snapshot: installed agent changed');
    }
    return { valid: true };
  });
  // Internal main-process seam; never exposed as a renderer action.
  const identity = (sender, request) => serial(async () => {
    const record = await lookup(sender, request);
    await validateRecord(record);
    return { name: record.name, marketplace: record.marketplaceName, version: record.version, checksum: record.checksum, previousNames: record.previousNames, authoringId: record.authoringId, description: record.description };
  });
  return { prepare, prepareAuthored, inspect, read, validate, materialize, materializeAgents, verifyInstalled, release, identity };
}

module.exports = { PLUGIN_SNAPSHOT_CHANNEL, createPluginSnapshotHost };
