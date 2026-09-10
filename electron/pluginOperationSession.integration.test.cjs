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

for (const timing of ['pinned', 'before-entry']) test(`tree publication protects the parent against replacement (${timing})`, () => {
  const { execFileSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-tree-boundary-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-tree-outside-'));
  const parent = path.join(home, '.abu', 'agents');
  fs.mkdirSync(parent, { recursive: true });
  try {
    execFileSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      const path = require('node:path');
      const { run } = require(process.argv[1]);
      const [home, outside, parent, timing] = process.argv.slice(2);
      process.chdir(home);
      const identity = fs.statSync('.');
      const parentIdentity = fs.statSync(parent);
      let attempted = false;
      let replaced = false;
      const replace = () => {
        attempted = true;
        fs.renameSync(parent, parent + '-old');
        fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
        replaced = true;
      };
      const io = { ...fs, mkdirSync(name, ...args) {
        if (timing === 'pinned' && name === '.incoming') {
          if (process.platform === 'win32') {
            // Windows locks cwd against rename. Assert that protection itself,
            // then let the legitimate publication finish in its original parent.
            assert.throws(replace, { code: 'EBUSY' });
            const current = fs.statSync(parent);
            assert.equal(current.ino, parentIdentity.ino);
            assert.equal(current.dev, parentIdentity.dev);
            assert.equal(fs.existsSync(parent + '-old'), false);
          } else replace();
        }
        return fs.mkdirSync(name, ...args);
      }};
      const chdir = name => {
        // Replace after lstat but before entering: no cwd lock protects this
        // directory yet, so the application's identity check must reject it.
        if (timing === 'before-entry' && name === 'agents') replace();
        process.chdir(name);
      };
      const publish = () => run({ identity, parent: ['.abu', 'agents'], parentIdentity,
        action: 'tree', temp: '.incoming', to: 'helper', tree: [['AGENT.md', Buffer.from('approved').toString('base64')]] }, io, chdir);
      if (timing === 'pinned' && process.platform === 'win32') {
        publish();
        assert.equal(replaced, false);
        assert.equal(fs.readFileSync(path.join(parent, 'helper', 'AGENT.md'), 'utf8'), 'approved');
        assert.equal(fs.existsSync(path.join(parent, '.incoming')), false);
      } else {
        assert.throws(publish, timing === 'before-entry' ? /directory changed/ : /parent changed/);
        assert.equal(replaced, true);
        assert.equal(fs.existsSync(path.join(parent + '-old', 'helper')), false);
      }
      assert.equal(attempted, true);
      assert.deepEqual(fs.readdirSync(outside), []);
    `, path.join(__dirname, 'pluginOperationWorker.cjs'), home, outside, parent, timing]);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

/**
 * Regression: a SIGKILLed worker (OOM, antivirus, memory pressure) closed the
 * session for the life of the process. The plugins tab's retry button routes
 * through the same session, so it re-awaited a cached rejected startup and
 * could never restore installing, updating or uninstalling.
 */
test('an explicit reopen restarts a killed worker, and a disposed session stays closed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-operation-reopen-'));
  const session = createOperationSession(home);
  try {
    await session.ready();
    const info = fs.statSync(home);
    const write = value => session.mutate({ home, identity: { ino: info.ino, dev: info.dev },
      parent: ['.abu', 'plugin-operations'], action: 'write', temp: `${value}.tmp`, to: 'active.enc',
      bytes: Buffer.from(value).toString('base64') });
    await write('before');

    process.kill(session.pid, 'SIGKILL');
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await session.ready(); await new Promise(resolve => setTimeout(resolve, 20)); }
      catch { break; }
    }
    await assert.rejects(session.ready(), /session/);

    assert.equal(session.reopen(), true);
    await session.ready();
    await write('after');
    assert.equal(fs.readFileSync(path.join(home, '.abu', 'plugin-operations', 'active.enc'), 'utf8'), 'after');

    await session.close();
    assert.equal(session.reopen(), false);
    await assert.rejects(session.ready(), /session closed/);
  } finally {
    await session.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});
