'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPluginOperationHost } = require('./pluginOperationHost.cjs');

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
    stat: async p => stat(get(p)),
    realpath: async p => { if (get(p).kind === 'link') return '/outside'; return norm(p); },
    readdir: async p => [...entries.keys()].filter(q => path.dirname(q) === norm(p) && q !== norm(p)).map(q => path.basename(q)),
    open: async (p, flags) => {
      if (flags === 'wx') {
        if (entries.has(norm(p))) throw error('EEXIST');
        add(p, 'file');
      }
      const e = get(p);
      if (e.kind === 'link') throw error('ELOOP');
      return { writeFile: async bytes => { e.bytes = Buffer.from(bytes); }, sync: async () => {}, stat: async () => stat(e), readFile: async () => Buffer.from(e.bytes),
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
      if (entries.has(norm(to)) && get(to).kind !== 'file') throw error('EEXIST');
      for (const [p, e] of [...entries]) if (p === norm(from) || p.startsWith(norm(from) + path.sep)) {
        entries.set(norm(to) + p.slice(norm(from).length), e); entries.delete(p);
      }
    },
    rm: async p => { for (const q of [...entries.keys()]) if (q === norm(p) || q.startsWith(norm(p) + path.sep)) entries.delete(q); },
  };
  return { api, entries, add, read: p => get(p).bytes.toString() };
}

const previous = { key: 'demo@market', marketplace: 'market', name: 'demo', version: '1', checksum: 'old',
  contributed: { skills: ['hello'], agents: ['helper'], mcpServers: ['server'] } };
const next = { ...previous, version: '2', checksum: 'new' };
function fixture({ installed = true, sameVersion = false } = {}) {
  const disk = memoryFs();
  const home = '/profile';
  disk.add(home, 'dir');
  let records = installed ? [structuredClone(previous)] : [];
  if (installed) {
    disk.add(`${home}/.abu/plugin-packages/market/demo/1/old.txt`, 'file', 'old package');
    disk.add(`${home}/.abu/agents/helper/AGENT.md`, 'file', '---\nname: helper\nsource: plugin:demo@market\n---\nold agent');
  }
  let index = 0;
  const record = sameVersion ? { ...next, version: '1' } : next;
  const registry = { dispatch: async (action, value) => {
    if (action === 'read') return JSON.stringify(records);
    if (action === 'upsert') records = [...records.filter(p => p.key !== value.record.key), structuredClone(value.record)];
    if (action === 'remove') records = records.filter(p => p.key !== value.key);
  } };
  const options = { home, registry, fs: disk.api, randomId: () => (++index).toString(16).padStart(32, '0'),
    snapshots: { identity: async () => record, verifyInstalled: async () => {}, materializeAgents: async () => record.contributed.agents, materialize: async () => {
      const targetDir = `${home}/.abu/plugin-packages/market/demo/${record.version}`;
      disk.add(`${targetDir}/new.txt`, 'file', 'new package');
      return { targetDir, checksum: record.checksum };
    } },
    mutate: async input => {
      const parent = path.join(home, ...input.parent);
      if (input.action === 'write') {
        disk.add(path.join(parent, input.temp), 'file', Buffer.from(input.bytes, 'base64'));
        await disk.api.rename(path.join(parent, input.temp), path.join(parent, input.to));
      } else {
        const info = await disk.api.lstat(path.join(parent, input.from));
        assert.equal(info.ino, input.source.ino);
        await disk.api.rename(path.join(parent, input.from), path.join(parent, input.to));
      }
    },
    encrypt: text => Buffer.from(text).map(n => n ^ 0x5a), decrypt: bytes => Buffer.from(bytes).map(n => n ^ 0x5a).toString(),
  };
  const host = createPluginOperationHost(options);
  const sender = { isDestroyed: () => false };
  const runtime = { enabled: true, servers: { server: { name: 'server', env: { TOKEN: 'secret-value' } } }, disabledSkills: {}, disabledAgents: {} };
  const begin = () => host.dispatch(sender, 'begin', { kind: installed ? 'update' : 'install', key: record.key, record, token: 'token', expected: installed ? previous : null, runtime });
  const materialize = async () => {
    await host.materialize(sender, { token: 'token' });
    disk.add(`${home}/.abu/agents/helper/AGENT.md`, 'file', '---\nname: helper\nsource: plugin:demo@market\n---\nnew agent');
  };
  return { disk, home, host, options, sender, runtime, begin, materialize, record, records: () => records };
}

test('a failed update restores the old package, agent and record, then waits for runtime acknowledgement', async () => {
  const f = fixture();
  const operation = await f.begin();
  await f.materialize();
  const restored = await f.host.dispatch(f.sender, 'rollback', operation);
  assert.equal(restored.phase, 'restored');
  assert.deepEqual(restored.runtime, f.runtime);
  assert.deepEqual(f.records(), [previous]);
  assert.equal(f.disk.read('/profile/.abu/plugin-packages/market/demo/1/old.txt'), 'old package');
  assert.match(f.disk.read('/profile/.abu/agents/helper/AGENT.md'), /old agent/);
  await assert.rejects(f.begin(), /needs completion/);
  await f.host.dispatch(f.sender, 'ack', operation);
  assert.equal(await f.host.dispatch(f.sender, 'status'), null);
});

test('same-version replacement preserves the previous bytes on failure', async () => {
  const f = fixture({ sameVersion: true });
  const op = await f.begin();
  await f.materialize();
  await f.host.dispatch(f.sender, 'rollback', op);
  assert.equal(f.disk.read('/profile/.abu/plugin-packages/market/demo/1/old.txt'), 'old package');
  assert.equal(f.disk.entries.has('/profile/.abu/plugin-packages/market/demo/1/new.txt'), false);
});

test('restart replays rollback idempotently before allowing new work', async () => {
  const f = fixture();
  await f.begin(); await f.materialize();
  const restarted = createPluginOperationHost(f.options);
  const restored = await restarted.dispatch(f.sender, 'recover');
  assert.equal(restored.phase, 'restored');
  assert.deepEqual(await restarted.dispatch(f.sender, 'recover'), restored);
  await restarted.dispatch(f.sender, 'ack', restored);
});

test('committed recovery retains the new record and supplies the new runtime state', async () => {
  const f = fixture();
  const op = await f.begin(); await f.materialize();
  const runtime = { enabled: false, servers: {}, disabledSkills: {}, disabledAgents: {} };
  await f.host.dispatch(f.sender, 'commit', { id: op.id, record: next, runtime });
  const restarted = createPluginOperationHost(f.options);
  const recovered = await restarted.dispatch(f.sender, 'recover');
  assert.equal(recovered.phase, 'committed');
  assert.deepEqual(recovered.runtime, runtime);
  assert.deepEqual(f.records(), [next]);
  await assert.rejects(restarted.dispatch(f.sender, 'rollback', op), /committed/);
  await restarted.dispatch(f.sender, 'ack', op);
});

test('uninstall moves only the owned version and agent; its interrupted operation restores both', async () => {
  const f = fixture();
  f.disk.add('/profile/.abu/plugin-packages/market/demo/data/keep.txt', 'file', 'user data');
  const op = await f.host.dispatch(f.sender, 'begin', { kind: 'uninstall', key: previous.key, expected: previous, runtime: f.runtime });
  await f.host.dispatch(f.sender, 'rollback', op);
  assert.equal(f.disk.read('/profile/.abu/plugin-packages/market/demo/data/keep.txt'), 'user data');
  assert.deepEqual(f.records(), [previous]);
});

test('independent or replaced agents are refused before any existing files move', async () => {
  const f = fixture();
  f.disk.add('/profile/.abu/agents/helper/AGENT.md', 'file', '---\nname: helper\n---\nuser-created');
  await assert.rejects(f.begin(), /ownership conflict/);
  assert.equal(f.disk.read('/profile/.abu/plugin-packages/market/demo/1/old.txt'), 'old package');
});

test('unapproved identities and contributions cannot be committed', async () => {
  const f = fixture(); const op = await f.begin(); await f.materialize();
  await assert.rejects(f.host.dispatch(f.sender, 'commit', { id: op.id, record: { ...next, name: 'other' }, runtime: f.runtime }), /identity mismatch/);
  await assert.rejects(f.host.dispatch(f.sender, 'commit', { id: op.id, record: { ...next, contributed: { ...next.contributed, agents: ['other'] } }, runtime: f.runtime }), /unapproved/);
  assert.deepEqual(f.records(), [previous]);
});

test('journal does not contain plaintext credentials and encryption failure preserves the old install', async () => {
  const f = fixture(); await f.begin();
  assert.equal(f.disk.read('/profile/.abu/plugin-operations/active.enc').includes('secret-value'), false);
  const g = fixture();
  const host = createPluginOperationHost({ ...g.options, encrypt: () => { throw new Error('keychain locked'); } });
  await assert.rejects(host.dispatch(g.sender, 'begin', { kind: 'update', key: next.key, record: next, token: 'token', expected: previous, runtime: g.runtime }), /keychain/);
  assert.equal(g.disk.read('/profile/.abu/plugin-packages/market/demo/1/old.txt'), 'old package');
});

test('other windows and direct registry mutations cannot overtake a pending operation', async () => {
  const f = fixture(); const op = await f.begin();
  await assert.rejects(f.host.dispatch({}, 'rollback', op), /another window/);
  await assert.rejects(f.host.dispatch({}, 'recover'), /another window/);
  let wrote = false;
  await assert.rejects(f.host.external('upsert', () => { wrote = true; }), /pending operation/);
  assert.equal(wrote, false);
});

test('initial installation rollback leaves no installed record or active agent', async () => {
  const f = fixture({ installed: false }); const op = await f.begin(); await f.materialize();
  await f.host.dispatch(f.sender, 'rollback', op);
  assert.deepEqual(f.records(), []);
  assert.equal(f.disk.entries.has('/profile/.abu/agents/helper'), false);
});


test('commit refuses a directory made outside the operation materializer', async () => {
  const f = fixture(); const op = await f.begin();
  f.disk.add('/profile/.abu/plugin-packages/market/demo/2/fake.txt', 'file', 'fake');
  await assert.rejects(f.host.dispatch(f.sender, 'commit', { id: op.id, record: next, runtime: f.runtime }), /not materialized/);
});

test('commit refuses a replaced materialized directory and missing owned agents', async () => {
  const f = fixture(); const op = await f.begin(); await f.materialize();
  await f.disk.api.rm('/profile/.abu/agents/helper');
  await assert.rejects(f.host.dispatch(f.sender, 'commit', { id: op.id, record: next, runtime: f.runtime }), /agent missing/);
  f.disk.add('/profile/.abu/plugin-packages/market/demo/2', 'dir');
  await assert.rejects(f.host.dispatch(f.sender, 'commit', { id: op.id, record: next, runtime: f.runtime }), /not materialized/);
});

test('missing backup cannot silently accept a replacement as the old version', async () => {
  const f = fixture({ sameVersion: true }); const op = await f.begin(); await f.materialize();
  for (const key of [...f.disk.entries.keys()]) if (key.includes('.abu-plugin-backup-') && key.includes('/demo/')) await f.disk.api.rm(key);
  await assert.rejects(f.host.dispatch(f.sender, 'rollback', op), /backup missing/);
  assert.equal((await f.host.dispatch(f.sender, 'status')).phase, 'prepared');
});

test('queued rollback waits for materialization and late materialization is refused', async () => {
  const f = fixture(); const op = await f.begin();
  const materialize = f.materialize();
  const rollback = f.host.dispatch(f.sender, 'rollback', op);
  await materialize; await rollback;
  await assert.rejects(f.host.materialize(f.sender, { token: 'token' }), /not owned/);
  assert.equal(f.disk.entries.has('/profile/.abu/plugin-packages/market/demo/2'), false);
});


test('a stale renderer cannot replace a changed installation record', async () => {
  const f = fixture();
  await f.options.registry.dispatch('upsert', { record: { ...previous, checksum: 'changed' } });
  await assert.rejects(f.begin(), /installation changed/);
  assert.equal(f.disk.read('/profile/.abu/plugin-packages/market/demo/1/old.txt'), 'old package');
});

test('uninstall preserves legacy agents without a verified on-disk ownership marker', async () => {
  const f = fixture();
  f.disk.add('/profile/.abu/agents/helper/AGENT.md', 'file', '---\nname: helper\n---\nlegacy');
  const op = await f.host.dispatch(f.sender, 'begin', { kind: 'uninstall', key: previous.key, expected: previous, runtime: f.runtime });
  assert.match(f.disk.read('/profile/.abu/agents/helper/AGENT.md'), /legacy/);
  await f.host.dispatch(f.sender, 'rollback', op);
});

test('commit cannot reactivate removed or uninstalled MCP servers', async () => {
  const f = fixture(); const op = await f.begin(); await f.materialize();
  const narrowed = { ...f.record, contributed: { ...f.record.contributed, mcpServers: [] } };
  await assert.rejects(f.host.dispatch(f.sender, 'commit', { id: op.id, record: narrowed, runtime: f.runtime }), /removed server/);
  assert.deepEqual(f.records(), [previous]);
  await f.host.dispatch(f.sender, 'commit', { id: op.id, record: narrowed, runtime: { ...f.runtime, servers: { server: null } } });
  const g = fixture();
  const uninstall = await g.host.dispatch(g.sender, 'begin', { kind: 'uninstall', key: previous.key, expected: previous, runtime: g.runtime });
  await assert.rejects(g.host.dispatch(g.sender, 'commit', { id: uninstall.id, record: null, runtime: g.runtime }), /cannot be enabled/);
  await assert.rejects(g.host.dispatch(g.sender, 'commit', { id: uninstall.id, record: null, runtime: { ...g.runtime, enabled: false, servers: {} } }), /removed server/);
  assert.deepEqual(g.records(), [previous]);
});

test('host rejects builtin and differently named folder claims before moving the old install', async () => {
  const f = fixture();
  const forged = { ...f.record, contributed: { ...f.record.contributed, agents: ['abu'] } };
  await assert.rejects(f.host.dispatch(f.sender, 'begin', { kind: 'update', key: forged.key, record: forged,
    token: 'token', expected: previous, runtime: f.runtime }), /agent ownership conflict/);
  f.disk.add('/profile/.abu/agents/my-helper/AGENT.md', 'file', '---\nname: helper\n---\nindependent agent');
  await assert.rejects(f.begin(), /agent ownership conflict/);
  assert.equal(f.disk.read('/profile/.abu/plugin-packages/market/demo/1/old.txt'), 'old package');
});

test('uninstall preserves a connector also claimed by another installed plugin', async () => {
  const f = fixture();
  const other = { ...previous, key: 'other@market', name: 'other', contributed: { skills: [], agents: [], mcpServers: ['server'] } };
  await f.options.registry.dispatch('upsert', { record: other });
  await assert.rejects(f.host.dispatch(f.sender, 'begin', { kind: 'uninstall', key: previous.key, expected: previous, runtime: f.runtime }), /outside plugin ownership/);
  const runtime = { ...f.runtime, servers: {} };
  const op = await f.host.dispatch(f.sender, 'begin', { kind: 'uninstall', key: previous.key, expected: previous, runtime });
  const resolved = await f.host.dispatch(f.sender, 'commit', { id: op.id, record: null, runtime: { ...runtime, enabled: false } });
  assert.deepEqual(resolved.runtime.servers, {});
  assert.deepEqual(resolved.expectedRuntime.servers, {});
  assert.deepEqual(f.records(), [other]);
});

for (const terminal of ['commit', 'recover']) {
  test(`approved marketplace rename ${terminal} keeps the correct record, package and agent identity`, async () => {
    const f = fixture();
    const renamed = { ...next, key: 'renamed@market', name: 'renamed' };
    f.options.snapshots.identity = async () => ({ ...renamed, previousNames: ['demo'] });
    f.options.snapshots.materialize = async () => {
      const targetDir = '/profile/.abu/plugin-packages/market/renamed/2';
      f.disk.add(`${targetDir}/new.txt`, 'file', 'renamed package');
      return { targetDir, checksum: renamed.checksum };
    };
    const op = await f.host.dispatch(f.sender, 'begin', { kind: 'update', key: previous.key, expected: previous,
      record: renamed, token: 'token', runtime: f.runtime });
    await f.host.materialize(f.sender, { token: 'token' });
    f.disk.add('/profile/.abu/agents/helper/AGENT.md', 'file', '---\nname: helper\nsource: plugin:renamed@market\n---\nnew agent');
    if (terminal === 'commit') {
      const result = await f.host.dispatch(f.sender, 'commit', { id: op.id, record: renamed, runtime: f.runtime });
      assert.equal(result.key, renamed.key);
      assert.deepEqual(f.records(), [renamed]);
      assert.equal(f.disk.read('/profile/.abu/plugin-packages/market/renamed/2/new.txt'), 'renamed package');
    } else {
      const restarted = createPluginOperationHost(f.options);
      const result = await restarted.dispatch({}, 'recover');
      assert.equal(result.key, previous.key);
      assert.deepEqual(f.records(), [previous]);
      assert.equal(f.disk.read('/profile/.abu/plugin-packages/market/demo/1/old.txt'), 'old package');
      assert.match(f.disk.read('/profile/.abu/agents/helper/AGENT.md'), /plugin:demo@market/);
      assert.equal(f.disk.entries.has('/profile/.abu/plugin-packages/market/renamed/2'), false);
    }
  });
}

test('unapproved rename cannot claim a different package identity', async () => {
  const f = fixture();
  const renamed = { ...next, key: 'renamed@market', name: 'renamed' };
  f.options.snapshots.identity = async () => renamed;
  await assert.rejects(f.host.dispatch(f.sender, 'begin', { kind: 'update', key: previous.key, expected: previous,
    record: renamed, token: 'token', runtime: f.runtime }), /unapproved.*rename/);
  assert.deepEqual(f.records(), [previous]);
  assert.equal(f.disk.read('/profile/.abu/plugin-packages/market/demo/1/old.txt'), 'old package');
});

/**
 * The plugins tab's retry button is the user's only way out after a worker
 * death, and it routes here. Recovery therefore restarts a closed session;
 * every other action keeps failing so a half-known state is never acted on.
 */
test('recovery restarts a session a worker death closed, other actions do not', async () => {
  const f = fixture();
  const stub = () => {
    let open = false, reopened = 0;
    return {
      get reopened() { return reopened; },
      reopen() { reopened++; open = true; return true; },
      ready: () => open ? Promise.resolve() : Promise.reject(new Error('Plugin operation: session closed')),
    };
  };

  const recovering = stub();
  assert.equal(await createPluginOperationHost({ ...f.options, session: recovering }).dispatch(f.sender, 'recover'), null);
  assert.equal(recovering.reopened, 1);

  const idle = stub();
  await assert.rejects(createPluginOperationHost({ ...f.options, session: idle }).dispatch(f.sender, 'status'), /session closed/);
  assert.equal(idle.reopened, 0);
});
