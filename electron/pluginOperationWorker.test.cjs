'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./pluginOperationWorker.cjs');

function fixture() {
  const profile = { ino: 1, dev: 1 };
  const parent = { ino: 2, dev: 1 };
  const original = { ino: 3, dev: 1, isSymbolicLink: () => false, isDirectory: () => true };
  let cwd = profile;
  const files = new Map([['old', original]]);
  const writes = [];
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  const io = {
    statSync: () => cwd,
    lstatSync: name => name === '.abu' ? { ...parent, isDirectory: () => true, isSymbolicLink: () => false } : files.get(name) ?? missing(),
    mkdirSync: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
    renameSync: (from, to) => { assert.equal(cwd, parent); assert.ok(!from.includes('/') && !to.includes('/')); files.set(to, files.get(from)); files.delete(from); writes.push([from, to]); },
    openSync: name => { assert.ok(!name.includes('/')); return name; },
    writeFileSync: (fd, bytes) => { files.set(fd, bytes); }, fsyncSync: () => {}, closeSync: () => {},
  };
  const chdir = () => { cwd = parent; };
  return { io, chdir, profile, original, files, writes };
}
test('move uses only inode-pinned parent and single-component names', () => {
  const f = fixture();
  run({ identity: f.profile, parent: ['.abu'], action: 'rename', from: 'old', to: 'backup', source: f.original }, f.io, f.chdir);
  assert.equal(f.files.get('backup'), f.original);
  assert.deepEqual(f.writes, [['old', 'backup']]);
});
test('source substitution, existing destination and unsafe paths produce no rename', () => {
  const f = fixture();
  const input = { identity: f.profile, parent: ['.abu'], action: 'rename', from: 'old', to: 'backup', source: { ino: 8, dev: 1 } };
  assert.throws(() => run(input, f.io, f.chdir), /source changed/);
  assert.deepEqual(f.writes, []);
  const g = fixture(); g.files.set('backup', g.original);
  assert.throws(() => run({ ...input, source: g.original }, g.io, g.chdir), /destination exists/);
  const h = fixture();
  assert.throws(() => run({ ...input, parent: ['..'] }, h.io, h.chdir), /invalid parent/);
});
test('encrypted journal is written then atomically renamed in the pinned directory', () => {
  const f = fixture();
  run({ identity: f.profile, parent: ['.abu'], action: 'write', temp: 'new.tmp', to: 'active.enc', bytes: Buffer.from('encrypted').toString('base64') }, f.io, f.chdir);
  assert.equal(f.files.get('active.enc').toString(), 'encrypted');
  assert.deepEqual(f.writes, [['new.tmp', 'active.enc']]);
});
test('replacing the profile before worker start fails before filesystem mutation', () => {
  const f = fixture();
  assert.throws(() => run({ identity: { ino: 99, dev: 1 } }, f.io, f.chdir), /profile changed/);
  assert.deepEqual(f.writes, []);
});

test('archive checks the confirmed bytes inside the worker, including same-inode rewrites', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const crypto = require('node:crypto');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abu-archive-worker-')));
  const cwd = process.cwd();
  try {
    const parent = path.join(home, '.abu/plugin-operations');
    fs.mkdirSync(parent, { recursive: true });
    const source = path.join(parent, 'active.enc');
    fs.writeFileSync(source, 'confirmed');
    const identity = fs.statSync(home);
    const original = fs.statSync(source);
    const fingerprint = crypto.createHash('sha256').update('confirmed').digest('hex');
    const input = { identity, parent: ['.abu', 'plugin-operations'], action: 'archive', from: 'active.enc', to: 'corrupt-1.enc', source: original, fingerprint };
    fs.writeFileSync(source, 'different');
    assert.equal(fs.statSync(source).ino, original.ino);
    process.chdir(home);
    assert.throws(() => run(input), /archive source changed/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'different');
    assert.equal(fs.existsSync(path.join(parent, 'corrupt-1.enc')), false);
    fs.writeFileSync(source, 'confirmed');
    process.chdir(home);
    assert.throws(() => run({ ...input, to: 'other.enc' }), /invalid archive/);
    process.chdir(home);
    run(input);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(path.join(parent, 'corrupt-1.enc'), 'utf8'), 'confirmed');
  } finally { process.chdir(cwd); fs.rmSync(home, { recursive: true, force: true }); }
});
