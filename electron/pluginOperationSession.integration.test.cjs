'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOperationSession } = require('./pluginOperationSession.cjs');

test('one live session excludes another reader and releases only after its writes finish', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-operation-session-'));
  const first = createOperationSession(home);
  const concurrent = createOperationSession(home);
  const restarted = createOperationSession(home);
  try {
    await first.ready();
    await assert.rejects(concurrent.ready(), /another write is active/);
    const info = fs.statSync(home);
    await first.mutate({ home, identity: { ino: info.ino, dev: info.dev }, parent: ['.abu', 'plugin-operations'],
      action: 'write', temp: 'sample.tmp', to: 'active.enc', bytes: Buffer.from('committed journal').toString('base64') });
    await first.registry({ home, identity: { ino: info.ino, dev: info.dev }, action: 'upsert', request: {
      record: { key: 'demo@market', name: 'demo', marketplace: 'market', version: '1', checksum: 'sample',
        contributed: { skills: [], agents: [], mcpServers: [] } } } });
    await first.close();
    await restarted.ready();
    assert.equal(fs.readFileSync(path.join(home, '.abu', 'plugin-operations', 'active.enc'), 'utf8'), 'committed journal');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.abu', 'plugin-packages', 'installed.json'), 'utf8'))[0].key, 'demo@market');
  } finally {
    await Promise.allSettled([first.close(), concurrent.close(), restarted.close()]);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const relative of ['.abu', '.abu/plugin-operations']) {
  test(`replaced lease ancestor ${relative} refuses writes before any new-tree side effect`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-operation-replaced-'));
    const session = createOperationSession(home);
    try {
      await session.ready();
      const replaced = path.join(home, relative);
      fs.renameSync(replaced, `${replaced}-old`);
      fs.mkdirSync(path.join(home, '.abu', 'plugin-operations'), { recursive: true });
      const identity = fs.statSync(home);
      await assert.rejects(session.mutate({ home, identity: { ino: identity.ino, dev: identity.dev },
        parent: ['.abu', 'plugin-operations'], action: 'write', temp: 'new.tmp', to: 'active.enc',
        bytes: Buffer.from('must not be written').toString('base64') }), /lease directory changed/);
      assert.equal(fs.existsSync(path.join(home, '.abu', 'plugin-operations', 'active.enc')), false);
      assert.equal(fs.existsSync(path.join(home, '.abu', 'plugin-operations', 'new.tmp')), false);
    } finally { await session.close(); fs.rmSync(home, { recursive: true, force: true }); }
  });
}

test('tree publication never writes through a replaced parent symlink', () => {
  const { execFileSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-tree-boundary-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-tree-outside-'));
  const parent = path.join(home, '.abu', 'agents');
  fs.mkdirSync(parent, { recursive: true });
  try {
    execFileSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const path = require('node:path');
      const assert = require('node:assert/strict');
      const { run } = require(process.argv[1]);
      const [home, outside, parent] = process.argv.slice(2);
      const probeRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'abu-symlink-probe-'));
      const probeTarget = path.join(probeRoot, 'target');
      const probeLink = path.join(probeRoot, 'link');
      let symlinkProbe;
      try {
        fs.mkdirSync(probeTarget);
        fs.symlinkSync(probeTarget, probeLink, 'dir');
        symlinkProbe = { ok: true };
      } catch (error) {
        symlinkProbe = { ok: false, code: error.code, message: error.message };
      } finally { fs.rmSync(probeRoot, { recursive: true, force: true }); }
      process.stderr.write('[SEC-442-B-probe] ' + JSON.stringify({ platform: process.platform, symlinkProbe }) + String.fromCharCode(10));
      process.chdir(home);
      const identity = fs.statSync('.');
      const parentIdentity = fs.statSync(parent);
      const io = { ...fs, mkdirSync(name, ...args) {
        if (name === '.incoming') {
          process.stderr.write('[SEC-442-B-before-rename] ' + JSON.stringify({
            cwd: process.cwd(),
            parent,
            cwdIdentityMatchesParent: (() => {
              const cwdIdentity = fs.statSync('.');
              return cwdIdentity.ino === parentIdentity.ino && cwdIdentity.dev === parentIdentity.dev;
            })(),
          }) + String.fromCharCode(10));
          try {
            fs.renameSync(parent, parent + '-old');
            process.stderr.write('[SEC-442-B-rename] ' + JSON.stringify({ ok: true, cwd: process.cwd() }) + String.fromCharCode(10));
          } catch (error) {
            process.stderr.write('[SEC-442-B-rename] ' + JSON.stringify({ ok: false, code: error.code, message: error.message }) + String.fromCharCode(10));
            throw error;
          }
          try {
            fs.symlinkSync(outside, parent, 'dir');
            process.stderr.write('[SEC-442-B-symlink] ' + JSON.stringify({ ok: true }) + String.fromCharCode(10));
          } catch (error) {
            process.stderr.write('[SEC-442-B-symlink] ' + JSON.stringify({ ok: false, code: error.code, message: error.message }) + String.fromCharCode(10));
            throw error;
          }
        }
        return fs.mkdirSync(name, ...args);
      }};
      assert.throws(() => run({ identity, parent: ['.abu', 'agents'], parentIdentity,
        action: 'tree', temp: '.incoming', to: 'helper', tree: [['AGENT.md', Buffer.from('approved').toString('base64')]] }, io), /parent changed/);
      assert.deepEqual(fs.readdirSync(outside), []);
    `, path.join(__dirname, 'pluginOperationWorker.cjs'), home, outside, parent]);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});
