'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createPluginSnapshotHost } = require('./pluginSnapshotHost.cjs');

// Model the filesystem, including exclusive creation, links and stable inodes.
// All I/O and time in these tests are deterministic.
function memoryFs(alias = null) {
  const entries = new Map();
  let ino = 0;
  const norm = p => {
    const resolved = path.resolve(p);
    return alias && (resolved === alias.from || resolved.startsWith(`${alias.from}${path.sep}`))
      ? alias.to + resolved.slice(alias.from.length) : resolved;
  };
  const error = code => Object.assign(new Error(code), { code });
  const add = (p, kind, content = '') => {
    p = norm(p);
    if (path.dirname(p) !== p && !entries.has(path.dirname(p))) add(path.dirname(p), 'dir');
    entries.set(p, { kind, bytes: Buffer.from(content), ino: ++ino });
  };
  const stat = e => ({
    isDirectory: () => e.kind === 'dir', isFile: () => e.kind === 'file',
    isSymbolicLink: () => e.kind === 'link', size: e.bytes.length,
    ino: e.ino, dev: 1, nlink: 1, mtimeMs: 1, ctimeMs: 1,
  });
  const get = p => { const e = entries.get(norm(p)); if (!e) throw error('ENOENT'); return e; };
  const api = {
    lstat: async p => stat(get(p)),
    realpath: async p => { if (get(p).kind === 'link') return '/outside'; return norm(p); },
    readdir: async p => [...entries.keys()].filter(q => path.dirname(q) === norm(p) && q !== norm(p)).map(q => path.basename(q)),
    open: async p => {
      const e = get(p);
      if (e.kind === 'link') throw error('ELOOP');
      return { stat: async () => stat(e), readFile: async () => Buffer.from(e.bytes),
        read: async (buffer, offset, length, position) => ({ bytesRead: e.bytes.copy(buffer, offset, position, position + length) }), close: async () => {} };
    },
    mkdir: async (p, options) => {
      if (entries.has(norm(p))) { if (options?.recursive && get(p).kind === 'dir') return; throw error('EEXIST'); }
      if (!options?.recursive && !entries.has(path.dirname(norm(p)))) throw error('ENOENT');
      add(p, 'dir');
    },
    writeFile: async (p, bytes, options) => {
      if (options?.flag === 'wx' && entries.has(norm(p))) throw error('EEXIST');
      if (!entries.has(path.dirname(norm(p)))) throw error('ENOENT');
      add(p, 'file', bytes);
    },
    rename: async (from, to) => {
      if (entries.has(norm(to))) throw error('EEXIST');
      for (const [p, e] of [...entries]) if (p === norm(from) || p.startsWith(norm(from) + path.sep)) {
        entries.set(norm(to) + p.slice(norm(from).length), e); entries.delete(p);
      }
    },
    rm: async p => { for (const q of [...entries.keys()]) if (q === norm(p) || q.startsWith(norm(p) + path.sep)) entries.delete(q); },
  };
  return { api, entries, add, read: p => get(p).bytes.toString() };
}

function fixture(options = {}) {
  const { alias, ...hostOptions } = options;
  const disk = memoryFs(alias);
  const home = path.resolve('/profile');
  const market = path.resolve('/market');
  disk.add(home, 'dir');
  disk.add(`${market}/.abu-plugin/marketplace.json`, 'file', JSON.stringify({ name: 'market', plugins: [{ name: 'demo', source: './plugins/demo' }] }));
  disk.add(`${market}/plugins/demo/.abu-plugin/plugin.json`, 'file', JSON.stringify({ name: 'demo', version: '1.0.0', mcpServers: { test: { command: 'approved' } } }));
  disk.add(`${market}/plugins/demo/skills/hello/SKILL.md`, 'file', 'approved skill');
  let id = 0; let now = 1000;
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  const host = createPluginSnapshotHost({ home, fs: disk.api, assertAllowed: p => p, randomId: () => `token-${++id}`, now: () => now, mutate: async input => {
    const parent = path.join(input.home, ...input.parent);
    if (input.action === 'ensure') {
      await disk.api.mkdir(parent, { recursive: true }); return;
    }
    const actual = await disk.api.lstat(parent);
    assert.equal(actual.ino, input.parentIdentity.ino);
    if (disk.entries.has(path.join(parent, input.to))) throw new Error('destination exists');
    const temp = path.join(parent, input.temp);
    await disk.api.mkdir(temp);
    for (const [relative, bytes] of input.tree) {
      const dest = path.join(temp, ...relative.split('/'));
      if (bytes === null) await disk.api.mkdir(dest);
      else await disk.api.writeFile(dest, Buffer.from(bytes, 'base64'), { flag: 'wx' });
    }
    await disk.api.rename(temp, path.join(parent, input.to));
  }, ...hostOptions });
  const request = { marketplaceDir: market, marketplaceName: 'market', entryName: 'demo' };
  return { disk, host, home, market, sender, request, advance: n => { now += n; } };
}

test('confirmation installs the prepared bytes even after the original source changes or disappears', async () => {
  const f = fixture();
  const prepared = await f.host.prepare(f.sender, f.request);
  f.disk.add(`${f.market}/plugins/demo/.abu-plugin/plugin.json`, 'file', '{"name":"demo","version":"9","mcpServers":{"test":{"command":"changed"}}}');
  await f.disk.api.rm(`${f.market}/plugins/demo/skills`);
  const installed = await f.host.materialize(f.sender, { token: prepared.token });
  assert.equal(installed.checksum, prepared.checksum);
  assert.match(f.disk.read(`${installed.targetDir}/.abu-plugin/plugin.json`), /approved/);
  assert.equal(f.disk.read(`${installed.targetDir}/skills/hello/SKILL.md`), 'approved skill');
});

test('tokens cannot cross senders or be materialized twice', async () => {
  const f = fixture(); const p = await f.host.prepare(f.sender, f.request);
  await assert.rejects(f.host.materialize(new EventEmitter(), { token: p.token }), /sender/);
  await f.host.materialize(f.sender, { token: p.token });
  await assert.rejects(f.host.materialize(f.sender, { token: p.token }), /consumed|unavailable/);
});

test('cancellation and expiry remove only the prepared area, leaving source and installed data', async () => {
  const f = fixture(); const p = await f.host.prepare(f.sender, f.request);
  await f.host.release(f.sender, { token: p.token });
  assert.equal(f.disk.entries.has(path.resolve(p.packageDir)), false);
  assert.match(f.disk.read(`${f.market}/plugins/demo/.abu-plugin/plugin.json`), /approved/);
  const p2 = await f.host.prepare(f.sender, f.request);
  f.advance(31 * 60 * 1000);
  await assert.rejects(f.host.materialize(f.sender, { token: p2.token }), /expired|unavailable/);
  assert.equal(f.disk.entries.has(path.resolve(p2.packageDir)), false);
});

test('refuses arbitrary target or source arguments and links escaping the package', async () => {
  const f = fixture();
  await assert.rejects(f.host.prepare(f.sender, { ...f.request, sourceDir: '/secret' }), /field/);
  f.disk.add(`${f.market}/plugins/demo/private`, 'link', '/secret');
  const p = await f.host.prepare(f.sender, f.request);
  assert.deepEqual(p.skippedSymlinks, ['private']);
  assert.equal(f.disk.entries.has(path.join(p.packageDir, 'private')), false);
  await assert.rejects(f.host.materialize(f.sender, { token: p.token, targetDir: '/secret' }), /field/);
});

test('refuses traversal and linked package roots before creating a snapshot', async () => {
  const f = fixture();
  f.disk.add(`${f.market}/.abu-plugin/marketplace.json`, 'file', JSON.stringify({ name: 'market', plugins: [{ name: 'demo', source: '../../secret' }] }));
  await assert.rejects(f.host.prepare(f.sender, f.request), /path|outside/);
  f.disk.add(`${f.market}/.abu-plugin/marketplace.json`, 'file', JSON.stringify({ name: 'market', plugins: [{ name: 'demo', source: './plugins/demo' }] }));
  f.disk.add(`${f.market}/plugins/demo`, 'link', '/secret');
  await assert.rejects(f.host.prepare(f.sender, f.request), /link/);
});

test('does not overwrite an existing version and keeps failed staging outside the published installation', async () => {
  const f = fixture(); const p = await f.host.prepare(f.sender, f.request);
  f.disk.add(`${f.home}/.abu/plugin-packages/market/demo/1.0.0/keep.txt`, 'file', 'old');
  await assert.rejects(f.host.materialize(f.sender, { token: p.token }), /exist/);
  assert.equal(f.disk.read(`${f.home}/.abu/plugin-packages/market/demo/1.0.0/keep.txt`), 'old');
  await f.disk.api.rm(`${f.home}/.abu/plugin-packages`);
  const write = f.disk.api.writeFile;
  f.disk.api.writeFile = async (p, ...args) => { if (p.includes('.incoming-') && p.endsWith('SKILL.md')) throw new Error('disk full'); return write(p, ...args); };
  await assert.rejects(f.host.materialize(f.sender, { token: p.token }), /disk full/);
  assert.equal(f.disk.entries.has(`${f.home}/.abu/plugin-packages/market/demo/1.0.0`), false);
  assert.equal([...f.disk.entries.keys()].some(p => p.includes('.incoming-')), true);
});

test('bounds package size, file count and outstanding snapshots', async () => {
  const small = fixture({ maxBytes: 1 });
  await assert.rejects(small.host.prepare(small.sender, small.request), /size|large|limit/);
  const f = fixture({ maxSnapshots: 1 });
  await f.host.prepare(f.sender, f.request);
  await assert.rejects(f.host.prepare(f.sender, f.request), /limit/);
  const files = fixture({ maxFiles: 1 });
  await assert.rejects(files.host.prepare(files.sender, files.request), /count.*limit/);
});

test('rejects changed preview bytes before materializing, then accepts a fresh preparation', async () => {
  const f = fixture(); const p = await f.host.prepare(f.sender, f.request);
  f.disk.add(`${p.packageDir}/.abu-plugin/plugin.json`, 'file', '{"name":"hidden"}');
  await assert.rejects(f.host.materialize(f.sender, { token: p.token }), /changed/);
  assert.equal(f.disk.entries.has(path.resolve(`${f.home}/.abu/plugin-packages/market/demo/1.0.0`)), false);
});

test('keeps capture bound to the authorized marketplace if realpath changes during root validation', async () => {
  const f = fixture(); const realpath = f.disk.api.realpath;
  const source = path.resolve(f.market, 'plugins/demo');
  f.disk.add('/outside/.abu-plugin/plugin.json', 'file', '{"name":"demo","version":"1.0.0"}');
  f.disk.api.realpath = async p => path.resolve(p) === source ? path.resolve('/outside') : realpath(p);
  await assert.rejects(f.host.prepare(f.sender, f.request), /outside|changed/);
});

test('refuses cleanup when an ancestor of the owned snapshot directory becomes a link', async () => {
  const f = fixture(); const p = await f.host.prepare(f.sender, f.request);
  f.disk.add(`${f.home}/.abu`, 'link', '/outside');
  await assert.rejects(f.host.release(f.sender, { token: p.token }), /link|outside/);
  assert.equal(f.disk.entries.has(path.resolve(p.packageDir)), true);
});

test('uses bounded descriptor reads instead of an unlimited readFile after checking size', async () => {
  const f = fixture(); const open = f.disk.api.open;
  f.disk.api.open = async (...args) => {
    const handle = await open(...args);
    handle.readFile = async () => { throw new Error('unbounded read forbidden'); };
    return handle;
  };
  const p = await f.host.prepare(f.sender, f.request);
  assert.ok(p.token);
});

test('preserves the application home spelling when its system ancestor is an alias', async () => {
  const f = fixture({ alias: { from: path.resolve('/profile'), to: path.resolve('/private/profile') } });
  const p = await f.host.prepare(f.sender, f.request);
  const installed = await f.host.materialize(f.sender, { token: p.token });
  assert.equal(installed.targetDir, path.join(f.home, '.abu', 'plugin-packages', 'market', 'demo', '1.0.0'));
  assert.equal(f.disk.read(`${installed.targetDir}/skills/hello/SKILL.md`), 'approved skill');
  await f.host.release(f.sender, { token: p.token });
  assert.equal([...f.disk.entries.keys()].some(name => name.includes(`${path.sep}plugin-prepared${path.sep}token-`)), false);
});

test('window destruction and main-frame navigation release its snapshots only', async () => {
  const f = fixture();
  const other = new EventEmitter(); other.isDestroyed = () => false;
  const kept = await f.host.prepare(other, f.request);
  const p = await f.host.prepare(f.sender, f.request);
  f.sender.emit('did-start-navigation', {}, 'file:///page', false, false);
  await f.host.validate(f.sender, { token: p.token }); // subframe navigation is unrelated
  f.sender.emit('did-start-navigation', {}, 'file:///page', false, true);
  await assert.rejects(f.host.validate(f.sender, { token: p.token }), /unavailable/);
  await f.host.validate(other, { token: kept.token });
  const next = await f.host.prepare(f.sender, f.request);
  f.sender.emit('destroyed');
  await assert.rejects(f.host.validate(f.sender, { token: next.token }), /unavailable/);
  await f.host.validate(other, { token: kept.token });
});

test('removes old session snapshots on first preparation without deleting other directories', async () => {
  const f = fixture();
  const stale = `${f.home}/.abu/plugin-prepared/${'a'.repeat(48)}`;
  f.disk.add(`${stale}/payload/old.txt`, 'file', 'stale');
  f.disk.add(`${f.home}/.abu/plugin-prepared/user-notes/keep.txt`, 'file', 'keep');
  await f.host.prepare(f.sender, f.request);
  assert.equal(f.disk.entries.has(path.resolve(stale)), false);
  assert.equal(f.disk.read(`${f.home}/.abu/plugin-prepared/user-notes/keep.txt`), 'keep');
});

test('remote capture uses the profile destination and drops fetched files on success or failure', async () => {
  for (const fail of [false, true]) {
    let f; let fetchedDir;
    f = fixture({ fetchRemote: async (_source, dest) => {
      fetchedDir = dest;
      assert.ok(dest.startsWith(path.join(f.home, '.abu', 'plugin-packages') + path.sep));
      f.disk.add(`${dest}/.abu-plugin/plugin.json`, 'file', '{"name":"demo","version":"1.0.0"}');
      if (fail) throw new Error('fetch interrupted');
      return { destDir: dest };
    } });
    f.disk.add(`${f.market}/.abu-plugin/marketplace.json`, 'file', JSON.stringify({ name: 'market', plugins: [{
      name: 'demo', source: { source: 'url', url: 'https://example.test/plugin.git', sha: 'a'.repeat(40) },
    }] }));
    if (fail) await assert.rejects(f.host.prepare(f.sender, f.request), /interrupted/);
    else {
      const p = await f.host.prepare(f.sender, f.request);
      const result = await f.host.materialize(f.sender, { token: p.token });
      assert.match(f.disk.read(`${result.targetDir}/.abu-plugin/plugin.json`), /demo/);
    }
    assert.equal(f.disk.entries.has(fetchedDir), false);
  }
});

test('cannot claim another marketplace identity for a prepared package', async () => {
  const f = fixture();
  await assert.rejects(f.host.prepare(f.sender, { ...f.request, marketplaceName: 'another-market' }), /marketplace identity/);
  assert.equal([...f.disk.entries.keys()].some(name => name.includes(`${path.sep}plugin-prepared${path.sep}`)), false);
});

test('preview inspection reads the captured bytes even if the disk copy is changed and restored', async () => {
  const f = fixture(); const p = await f.host.prepare(f.sender, f.request);
  const file = `${p.packageDir}/.abu-plugin/plugin.json`;
  const original = f.disk.read(file);
  f.disk.add(file, 'file', '{"name":"demo","version":"1.0.0","mcpServers":{"test":{"command":"benign-preview"}}}');
  const index = await f.host.inspect(f.sender, { token: p.token });
  assert.ok(index.some(entry => entry.path === '.abu-plugin/plugin.json' && !entry.isDirectory));
  const shown = await f.host.read(f.sender, { token: p.token, path: '.abu-plugin/plugin.json' });
  assert.equal(shown, original);
  await assert.rejects(f.host.read(new EventEmitter(), { token: p.token, path: '.abu-plugin/plugin.json' }), /sender/);
  await assert.rejects(f.host.read(f.sender, { token: p.token, path: '../private' }), /file/);
  f.disk.add(file, 'file', original);
  const installed = await f.host.materialize(f.sender, { token: p.token });
  assert.equal(f.disk.read(`${installed.targetDir}/.abu-plugin/plugin.json`), shown);
});

test('commit proof detects in-place edits without a package directory inode change', async () => {
  const f = fixture(); const prepared = await f.host.prepare(f.sender, f.request);
  const installed = await f.host.materialize(f.sender, { token: prepared.token });
  const before = await f.disk.api.lstat(installed.targetDir);
  await f.host.verifyInstalled(f.sender, { token: prepared.token }, []);
  f.disk.add(`${installed.targetDir}/skills/hello/SKILL.md`, 'file', 'unapproved replacement');
  assert.equal((await f.disk.api.lstat(installed.targetDir)).ino, before.ino);
  await assert.rejects(f.host.verifyInstalled(f.sender, { token: prepared.token }, []), /installed package changed/);
});

test('agents are derived from approved bytes without rewriting the installed package', async () => {
  const f = fixture();
  f.disk.add(`${f.market}/plugins/demo/agents/helper.md`, 'file', '---\nname: helper\nsource: plugin:forged@other\nmemory: user\n---\napproved prompt');
  const prepared = await f.host.prepare(f.sender, f.request);
  await f.host.materialize(f.sender, { token: prepared.token });
  assert.deepEqual(await f.host.materializeAgents(f.sender, { token: prepared.token }, ['helper']), ['helper']);
  const target = `${f.home}/.abu/agents/helper/AGENT.md`;
  assert.match(f.disk.read(target), /source: plugin:demo@market/);
  assert.doesNotMatch(f.disk.read(target), /memory:|forged/);
  await f.host.verifyInstalled(f.sender, { token: prepared.token }, ['helper']);
  f.disk.add(target, 'file', '---\nname: helper\nsource: plugin:demo@market\n---\nchanged prompt');
  await assert.rejects(f.host.verifyInstalled(f.sender, { token: prepared.token }, ['helper']), /installed agent changed/);
});
