'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPluginRegistryHost, applyRegistryMutation } = require('./pluginRegistryHost.cjs');
const HOME = path.resolve('/profile');
const FILE = path.join(HOME, '.abu', 'plugin-packages', 'installed.json');
const plugin = (name = 'demo', extra = {}) => ({ key: `${name}@market`, name, marketplace: 'market', version: '1', contributed: { skills: [], mcpServers: [], agents: [] }, ...extra });

function fixture() {
  const files = new Map(); const handles = new Map(); const events = [];
  let inode = 0; let descriptor = 0; let sequence = 0;
  const error = code => Object.assign(new Error(code), { code });
  const put = (name, content, kind = 'file') => {
    name = path.resolve(name);
    if (path.dirname(name) !== name && !files.has(path.dirname(name))) put(path.dirname(name), '', 'dir');
    files.set(name, { bytes: Buffer.from(content), kind, ino: ++inode });
  };
  const get = name => { const entry = files.get(path.resolve(name)); if (!entry) throw error('ENOENT'); return entry; };
  const stat = e => ({ ino: e.ino, dev: 1, nlink: e.nlink || 1, size: e.bytes.length, mtimeMs: 1, ctimeMs: 1,
    isFile: () => e.kind === 'file', isDirectory: () => e.kind === 'dir', isSymbolicLink: () => e.kind === 'link' });
  const fs = {
    realpathSync: name => { get(name); return path.resolve(name); },
    lstatSync: name => stat(get(name)),
    statSync: name => stat(get(name)),
    readdirSync: name => [...files.keys()].filter(p => path.dirname(p) === path.resolve(name)).map(p => path.basename(p)),
    mkdirSync: name => { if (files.has(path.resolve(name))) throw error('EEXIST'); put(name, '', 'dir'); },
    openSync: (name, flags) => {
      if (flags === 'wx') {
        if (files.has(path.resolve(name))) throw error('EEXIST');
        put(name, '');
      }
      const entry = get(name);
      handles.set(++descriptor, entry);
      return descriptor;
    },
    fstatSync: fd => stat(handles.get(fd)),
    readSync: (fd, buffer, offset, length, position) => handles.get(fd).bytes.copy(buffer, offset, position, position + length),
    closeSync: fd => { handles.delete(fd); },
    writeFileSync: (fd, raw) => { events.push('write'); handles.get(fd).bytes = Buffer.from(raw); },
    fsyncSync: () => { events.push('sync'); },
    renameSync: (from, to) => {
      events.push('rename'); from = path.resolve(from); to = path.resolve(to); get(from);
      if (files.get(to)?.kind === 'dir' && [...files.keys()].some(name => name.startsWith(to + path.sep))) throw error('ENOTEMPTY');
      for (const [name, entry] of [...files]) if (name === from || name.startsWith(from + path.sep)) {
        files.set(to + name.slice(from.length), entry); files.delete(name);
      }
    },
    unlinkSync: name => files.delete(path.resolve(name)),
    rmdirSync: name => files.delete(path.resolve(name)),
  };
  put(HOME, '', 'dir');
  const options = { home: HOME, fs, mutate: ({ action, request }) => {
    // The worker's cwd boundary is tested separately; this adapter tests the
    // exact shared mutation implementation against a deterministic filesystem.
    for (const dir of [path.join(HOME, '.abu'), path.dirname(FILE)]) {
      if (!files.has(dir)) { if (action === 'remove') return; put(dir, '', 'dir'); }
      if (get(dir).kind !== 'dir') throw new Error('linked directory refused');
    }
    return applyRegistryMutation(action, request, { fs, file: FILE, randomId: () => (++sequence).toString(16).padStart(32, '0') });
  } };
  const host = createPluginRegistryHost(options);
  const request = (action, value = {}) => host.dispatch(action, { home: HOME, ...value });
  return { files, fs, put, events, options, host, request, raw: () => get(FILE).bytes.toString() };
}

test('concurrent insertions are serialized against the latest records, including after an error', async () => {
  const f = fixture();
  await Promise.all([
    f.request('upsert', { record: plugin('first') }),
    assert.rejects(f.request('upsert', { record: { invalid: true } })),
    f.request('upsert', { record: plugin('second') }),
  ]);
  assert.deepEqual(JSON.parse(f.raw()).map(p => p.name), ['first', 'second']);
  assert.deepEqual(f.events, ['write', 'sync', 'rename', 'write', 'sync', 'rename']);
});

test('interleaved updates and removal preserve unrelated records and unknown fields', async () => {
  const f = fixture();
  f.put(FILE, JSON.stringify([plugin('a'), plugin('b', { futureMetadata: { ownership: 'keep' } })]));
  await Promise.all([
    f.request('upsert', { record: plugin('a', { version: '2' }) }),
    f.request('remove', { key: 'b@market' }),
    f.request('upsert', { record: plugin('c') }),
  ]);
  assert.deepEqual(JSON.parse(f.raw()), [plugin('a', { version: '2' }), plugin('c')]);
  await f.request('upsert', { record: plugin('b', { futureMetadata: { ownership: 'keep' } }) });
  await f.request('remove', { key: 'a@market' });
  assert.equal(JSON.parse(f.raw()).find(p => p.name === 'b').futureMetadata.ownership, 'keep');
});

for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`${operation} failure leaves the previous complete file readable after restart`, async () => {
    const f = fixture(); const raw = JSON.stringify([plugin()]); f.put(FILE, raw);
    const original = f.fs[operation];
    f.fs[operation] = () => { throw new Error('injected write failure'); };
    await assert.rejects(f.request('upsert', { record: plugin('next') }), /injected/);
    assert.equal(f.raw(), raw);
    assert.equal([...f.files.keys()].some(p => p.endsWith('.tmp')), false);
    f.fs[operation] = original;
    const restarted = createPluginRegistryHost(f.options);
    assert.equal(await restarted.dispatch('read', { home: HOME }), raw);
    await restarted.dispatch('upsert', { home: HOME, record: plugin('next') });
    assert.equal(JSON.parse(f.raw()).length, 2);
  });
}

for (const raw of ['{invalid', '{}', JSON.stringify([plugin(), { key: 'broken' }]), JSON.stringify([plugin(), plugin()]), JSON.stringify([plugin('demo', { key: 'other@market' })])]) {
  test(`refuses to mutate corrupt or ambiguous records: ${raw.slice(0, 45)}`, async () => {
    const f = fixture(); f.put(FILE, raw);
    await assert.rejects(f.request('read', { forWrite: true }));
    await assert.rejects(f.request('upsert', { record: plugin('next') }));
    await assert.rejects(f.request('remove', { key: 'demo@market' }));
    assert.equal(f.raw(), raw);
    assert.deepEqual(f.events, []);
  });
}

test('missing profile records and missing removals are read-only no-ops', async () => {
  const f = fixture();
  assert.equal(await f.request('read'), null);
  await f.request('remove', { key: 'demo@market' });
  assert.equal(f.files.has(path.dirname(FILE)), false);
  f.put(FILE, JSON.stringify([plugin()]));
  await f.request('remove', { key: 'missing@market' });
  assert.deepEqual(f.events, []);
});

test('does not remove or follow a preseeded temporary path', async () => {
  const f = fixture();
  f.put(FILE, '[]');
  const temporary = path.join(path.dirname(FILE), `.installed-${'1'.padStart(32, '0')}.tmp`);
  f.put(temporary, 'user-data', 'link');
  await assert.rejects(f.request('upsert', { record: plugin() }), /EEXIST/);
  assert.equal(f.files.get(temporary).bytes.toString(), 'user-data');
  assert.equal(f.raw(), '[]');
});

test('rejects symlinked parents, symlinked files, hardlinks, devices and oversized files', async () => {
  for (const [target, kind] of [[path.join(HOME, '.abu'), 'link'], [path.dirname(FILE), 'link'], [FILE, 'link'], [FILE, 'dir'], [FILE, 'device']]) {
    const f = fixture(); f.put(target, '', kind);
    await assert.rejects(f.request('upsert', { record: plugin() }), /refused/);
    assert.deepEqual(f.events, []);
  }
  const f = fixture(); f.put(FILE, '[]'); f.files.get(FILE).nlink = 2;
  await assert.rejects(f.request('read'), /refused/);
  f.files.get(FILE).nlink = 1; f.files.get(FILE).bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
  await assert.rejects(f.request('read'), /size limit/);
});

test('rejects unsupported actions, arbitrary profiles/paths and unsafe identities before writing', async () => {
  const f = fixture();
  for (const [action, request] of [
    ['replace', { home: HOME, records: [] }], ['read', { home: HOME, path: '/secret' }],
    ['read', { home: '/other' }], ['read', { home: 'relative' }],
    ['remove', { home: HOME, key: null }],
    ...['..', '../escape', 'a\\b', 'nul', 'name.', 'c:drive'].map(name => ['upsert', { home: HOME, record: plugin(name) }]),
  ]) await assert.rejects(f.host.dispatch(action, request));
  assert.deepEqual(f.events, []);
});

test('captures queued input and reads only the bounded prechecked file length', async () => {
  const f = fixture(); const record = plugin();
  const pending = f.request('upsert', { record }); record.name = 'changed';
  await pending;
  assert.equal(JSON.parse(f.raw())[0].name, 'demo');
  const read = f.fs.readSync;
  f.fs.readSync = (...args) => { const count = read(...args); f.files.get(FILE).bytes = Buffer.from('changed'); return count; };
  await assert.rejects(f.request('read'), /changed/);
});

test('retains pre-agents and additional schema fields without lossy normalization', async () => {
  const f = fixture(); const legacy = plugin('legacy', { contributed: { skills: [], mcpServers: [] }, futureField: true });
  f.put(FILE, JSON.stringify([legacy]));
  await f.request('upsert', { record: plugin() });
  assert.deepEqual(JSON.parse(f.raw())[0], legacy);
});


test('record limit rejects only a new insertion and still permits update/removal', async () => {
  const f = fixture();
  f.put(FILE, JSON.stringify(Array.from({ length: 10000 }, (_, i) => plugin(`p${i}`))));
  const before = f.raw();
  await assert.rejects(f.request('upsert', { record: plugin('overflow') }), /invalid/);
  assert.equal(f.raw(), before);
  await f.request('upsert', { record: plugin('p0', { version: '2' }) });
  await f.request('remove', { key: 'p1@market' });
  assert.equal(JSON.parse(f.raw()).length, 9999);
});

test('worker refuses a directory swapped between lstat and chdir', () => {
  const { enterDirectory } = require('./pluginRegistryWorker.cjs');
  const io = { lstatSync: () => ({ ino: 1, dev: 1, isDirectory: () => true, isSymbolicLink: () => false }),
    statSync: () => ({ ino: 2, dev: 1 }) };
  assert.throws(() => enterDirectory('plugin-packages', false, io, () => {}), /directory changed/);
});

test('worker verifies its initial cwd before creating any directory', () => {
  const { run } = require('./pluginRegistryWorker.cjs');
  assert.throws(() => run({ identity: { ino: 1, dev: 1 } }, { statSync: () => ({ ino: 2, dev: 1 }) }), /profile changed/);
});

test('read rejects a file temporarily substituted and restored during descriptor reading', async () => {
  const f = fixture(); f.put(FILE, JSON.stringify([plugin()]));
  const original = f.files.get(FILE); let substituted = false;
  const lstat = f.fs.lstatSync; const read = f.fs.readSync;
  f.fs.lstatSync = name => {
    if (name === FILE && !substituted) { substituted = true; f.put(FILE, 'unrelated-content'); }
    return lstat(name);
  };
  f.fs.readSync = (...args) => { const count = read(...args); f.files.set(FILE, original); return count; };
  await assert.rejects(f.request('read'), /file changed/);
});

test('worker relative writes stay in the pinned directory when its old pathname is replaced', () => {
  const { run } = require('./pluginRegistryWorker.cjs');
  const f = fixture(); f.put(FILE, JSON.stringify([plugin()]));
  const root = path.dirname(FILE); const parked = path.resolve('/parked');
  const outsideFile = path.resolve('/outside/installed.json');
  f.put(outsideFile, 'unrelated-content');
  let cwdInode = f.files.get(HOME).ino; let swapped = false;
  const cwdPath = () => [...f.files].find(([, entry]) => entry.ino === cwdInode)[0];
  const resolve = name => path.resolve(cwdPath(), name);
  const io = { ...f.fs };
  for (const method of ['lstatSync', 'mkdirSync', 'openSync', 'unlinkSync', 'rmdirSync', 'readdirSync']) {
    io[method] = (name, ...rest) => f.fs[method](resolve(name), ...rest);
  }
  io.renameSync = (from, to) => f.fs.renameSync(resolve(from), resolve(to));
  io.statSync = name => {
    const result = f.fs.statSync(resolve(name));
    if (!swapped && cwdPath() === root) {
      swapped = true;
      for (const [name, entry] of [...f.files]) if (name === root || name.startsWith(root + path.sep)) {
        f.files.delete(name); f.files.set(parked + name.slice(root.length), entry);
      }
      f.put(root, '/outside', 'link');
    }
    return result;
  };
  const chdir = name => { cwdInode = f.files.get(resolve(name)).ino; };
  const home = f.fs.statSync(HOME);
  run({ identity: { ino: home.ino, dev: home.dev }, action: 'upsert', request: { record: plugin('next') } }, io, chdir, () => 'a'.repeat(32));
  assert.equal(swapped, true);
  assert.equal(f.files.get(outsideFile).bytes.toString(), 'unrelated-content');
  assert.deepEqual(JSON.parse(f.files.get(path.join(parked, 'installed.json')).bytes.toString()).map(p => p.name), ['demo', 'next']);
});

test('pins the profile identity for the lifetime of the coordinator', async () => {
  const f = fixture();
  f.put(HOME, '', 'dir');
  await assert.rejects(f.request('read'), /profile changed/);
  await assert.rejects(f.request('upsert', { record: plugin() }), /profile changed/);
  assert.deepEqual(f.events, []);
});


test('coordinator drains the active writer and rejects queued/new requests on shutdown', async () => {
  const f = fixture(); let finish;
  const host = createPluginRegistryHost({ ...f.options, mutate: () => new Promise(resolve => { finish = resolve; }) });
  const active = host.dispatch('upsert', { home: HOME, record: plugin() });
  await Promise.resolve();
  const queued = host.dispatch('upsert', { home: HOME, record: plugin('queued') });
  const queuedRejection = assert.rejects(queued, /shutting down/);
  let drained = false;
  const shutdown = host.shutdown().then(() => { drained = true; });
  await assert.rejects(host.dispatch('read', { home: HOME }), /shutting down/);
  assert.equal(drained, false);
  finish();
  await Promise.all([active, queuedRejection, shutdown]);
  assert.equal(drained, true);
});

test('validates prospective records and registry limits without changing the file', async () => {
  const f = fixture(); f.put(FILE, JSON.stringify([plugin()])); const before = f.raw();
  await f.request('validate', { record: plugin('next') });
  await assert.rejects(f.request('validate', { record: plugin('next', { version: 'dev:build' }) }), /invalid record/);
  assert.equal(f.raw(), before);
  assert.deepEqual(f.events, []);
});

test('worker refuses an existing write lock instead of racing a previous process', () => {
  const { run } = require('./pluginRegistryWorker.cjs');
  const stat = { ino: 1, dev: 1, isDirectory: () => true, isSymbolicLink: () => false };
  const io = { statSync: () => stat, lstatSync: () => stat,
    mkdirSync: name => { if (name === '.installed-write-lock') throw Object.assign(new Error('busy'), { code: 'EEXIST' }); },
    readdirSync: () => [], openSync: () => { throw new Error('must not read or write registry'); } };
  assert.throws(() => run({ identity: stat, action: 'upsert', request: { record: plugin() } }, io, () => {}), /another write is active or interrupted/);
});

test('first-install validation applies the pretty-JSON size limit without creating a directory', () => {
  const { run } = require('./pluginRegistryWorker.cjs');
  const record = plugin('demo', { future: Object.fromEntries(Array.from({ length: 220000 }, (_, i) => [`a${i}`, 0])) });
  const input = { identity: { ino: 1, dev: 1 }, action: 'validate', request: { record } };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 4 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify([record], null, 2)) > 4 * 1024 * 1024);
  const io = { statSync: () => input.identity,
    lstatSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    mkdirSync: () => { throw new Error('must not create a directory'); } };
  assert.throws(() => run(input, io, () => {}), /size limit/);
});


test('write lock recovery reclaims only a dead known worker', () => {
  const { acquireWriteLock } = require('./pluginRegistryWorker.cjs');
  for (const alive of [true, false]) {
    const f = fixture(); const parent = path.dirname(FILE);
    f.put(path.join(parent, '.installed-write-lock/owner-123'), '');
    let cwd = parent;
    const io = { ...f.fs };
    for (const method of ['statSync', 'lstatSync', 'mkdirSync', 'openSync', 'unlinkSync', 'rmdirSync', 'readdirSync']) io[method] = (name, ...rest) => f.fs[method](path.resolve(cwd, name), ...rest);
    io.renameSync = (from, to) => f.fs.renameSync(path.resolve(cwd, from), path.resolve(cwd, to));
    const chdir = name => { cwd = path.resolve(cwd, name); };
    if (alive) {
      assert.throws(() => acquireWriteLock(io, chdir, 456, () => true), /active or interrupted/);
      assert.ok(f.files.has(path.join(parent, '.installed-write-lock/owner-123')));
    } else {
      const release = acquireWriteLock(io, chdir, 456, () => false, () => 'b'.repeat(32));
      assert.ok(f.files.has(path.join(parent, `.installed-write-lock/owner-456-${'b'.repeat(32)}`)));
      release();
      assert.equal(f.files.has(path.join(parent, '.installed-write-lock')), false);
    }
  }
});

test('lease crashes before publication or after retirement never leave an empty active lock', () => {
  const { acquireWriteLock } = require('./pluginRegistryWorker.cjs');
  for (const phase of ['prepare', 'retire']) {
    const f = fixture(); f.put(FILE, '[]'); const parent = path.dirname(FILE);
    let cwd = parent;
    const io = { ...f.fs };
    for (const method of ['statSync', 'lstatSync', 'mkdirSync', 'openSync', 'unlinkSync', 'rmdirSync', 'readdirSync']) io[method] = (name, ...rest) => f.fs[method](path.resolve(cwd, name), ...rest);
    io.renameSync = (from, to) => {
      if (phase === 'prepare' && from.startsWith('.installed-lock-prepared-')) throw new Error('crash before publish');
      f.fs.renameSync(path.resolve(cwd, from), path.resolve(cwd, to));
      if (phase === 'retire' && from === '.installed-write-lock') throw new Error('crash after retirement');
    };
    const chdir = name => { cwd = path.resolve(cwd, name); };
    if (phase === 'prepare') assert.throws(() => acquireWriteLock(io, chdir, 123, () => false, () => 'a'.repeat(32)), /crash/);
    else {
      const release = acquireWriteLock(io, chdir, 123, () => false, () => 'a'.repeat(32));
      assert.throws(release, /crash/);
    }
    assert.equal(f.files.has(path.join(parent, '.installed-write-lock')), false);
    io.renameSync = (from, to) => f.fs.renameSync(path.resolve(cwd, from), path.resolve(cwd, to));
    const release = acquireWriteLock(io, chdir, 456, () => false, () => 'b'.repeat(32));
    release();
  }
});

test('a stale reclaimer cannot rename a newly published live lock', () => {
  const { acquireWriteLock } = require('./pluginRegistryWorker.cjs');
  const f = fixture(); f.put(FILE, '[]'); const parent = path.dirname(FILE);
  const old = 'a'.repeat(32), live = 'b'.repeat(32);
  f.put(path.join(parent, `.installed-write-lock/owner-123-${old}`), '');
  let cwd = parent, raced = false;
  const io = { ...f.fs };
  for (const method of ['statSync', 'lstatSync', 'mkdirSync', 'openSync', 'unlinkSync', 'rmdirSync', 'readdirSync']) io[method] = (name, ...rest) => f.fs[method](path.resolve(cwd, name), ...rest);
  io.renameSync = (from, to) => {
    if (!raced && from === '.installed-write-lock') {
      raced = true;
      // Another reclaimer has just retired old, then a live process acquired.
      f.fs.renameSync(path.resolve(cwd, from), path.resolve(cwd, `.installed-lock-retired-${old}`));
      f.put(path.join(parent, `.installed-write-lock/owner-456-${live}`), '');
    }
    f.fs.renameSync(path.resolve(cwd, from), path.resolve(cwd, to));
  };
  const chdir = name => { cwd = path.resolve(cwd, name); };
  assert.throws(() => acquireWriteLock(io, chdir, 789, pid => pid === 456, () => 'c'.repeat(32)), /active/);
  assert.ok(f.files.has(path.join(parent, `.installed-write-lock/owner-456-${live}`)));
});
