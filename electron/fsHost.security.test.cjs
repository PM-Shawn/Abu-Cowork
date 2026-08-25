'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { fsDispatch, canonicalizeForPathPolicy } = require('./fsHost.cjs');
const { fsWatchDispatch, cleanupFsWatchesForSender } = require('./fsWatchHost.cjs');

const app = {};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-fs-security-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('normal files stay readable and stat returns the Tauri FileInfo shape', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'normal.txt');
  fs.writeFileSync(file, 'inside');

  const bytes = fsDispatch(app, 'plugin:fs|read_text_file', { args: { path: file } });
  assert.equal(bytes.toString('utf8'), 'inside');

  const info = fsDispatch(app, 'plugin:fs|stat', { args: { path: file } });
  assert.equal(info.isFile, true);
  assert.equal(info.isDirectory, false);
  assert.equal(info.isSymlink, false);
  assert.equal(info.size, 6);
  assert.equal(typeof info.mtime, 'string');
});

test(
  'stat/read/write reject a symlink that escapes an allowed root while lstat can inspect the link',
  { skip: process.platform === 'win32' },
  (t) => {
    const dir = tempDir(t);
    const link = path.join(dir, 'outside');
    fs.symlinkSync('/etc', link);

    const lstat = fsDispatch(app, 'plugin:fs|lstat', { args: { path: link } });
    assert.equal(lstat.isSymlink, true);

    assert.throws(
      () => fsDispatch(app, 'plugin:fs|stat', { args: { path: link } }),
      /escapes the allowed scope through a symlink/
    );
    assert.throws(
      () =>
        fsDispatch(app, 'plugin:fs|read_text_file', {
          args: { path: path.join(link, 'hosts') },
        }),
      /escapes the allowed scope through a symlink/
    );

    const escapedTarget = path.join(link, `abu-must-not-exist-${process.pid}`);
    assert.throws(
      () =>
        fsDispatch(app, 'plugin:fs|write_text_file', {
          body: Buffer.from('blocked'),
          headers: {
            path: encodeURIComponent(escapedTarget),
            options: '{}',
          },
        }),
      /escapes the allowed scope through a symlink/
    );
    assert.equal(fs.existsSync(`/etc/${path.basename(escapedTarget)}`), false);
  }
);

test(
  'a dangling symlink is rejected instead of being treated as a safe missing write target',
  { skip: process.platform === 'win32' },
  (t) => {
    const dir = tempDir(t);
    const link = path.join(dir, 'dangling');
    fs.symlinkSync(`/etc/abu-missing-${process.pid}`, link);

    assert.throws(
      () =>
        fsDispatch(app, 'plugin:fs|write_file', {
          body: Buffer.from('blocked'),
          headers: {
            path: encodeURIComponent(link),
            options: '{}',
          },
        }),
      /cannot resolve path safely/
    );
  }
);

test('symlinks whose canonical target remains in an allowed root keep working', (t) => {
  const dir = tempDir(t);
  const targetDir = tempDir(t);
  const target = path.join(targetDir, 'allowed.txt');
  const link = path.join(dir, 'allowed-link.txt');
  fs.writeFileSync(target, 'allowed');
  fs.symlinkSync(target, link);

  const bytes = fsDispatch(app, 'plugin:fs|read_text_file', { args: { path: link } });
  assert.equal(bytes.toString('utf8'), 'allowed');
});

test('path-policy canonicalization resolves an allowed symlink and a missing write tail', (t) => {
  const dir = tempDir(t);
  const targetDir = tempDir(t);
  const linkDir = path.join(dir, 'policy-link');
  fs.symlinkSync(targetDir, linkDir);

  assert.equal(
    canonicalizeForPathPolicy(path.join(linkDir, 'nested', 'future.txt')),
    path.join(fs.realpathSync.native(targetDir), 'nested', 'future.txt')
  );
});

test('path-policy entry canonicalization resolves the parent without following the final symlink', (t) => {
  const dir = tempDir(t);
  const targetDir = tempDir(t);
  const target = path.join(targetDir, 'target.txt');
  const link = path.join(dir, 'entry-link.txt');
  fs.writeFileSync(target, 'target');
  fs.symlinkSync(target, link);

  assert.equal(canonicalizeForPathPolicy(link, true), fs.realpathSync.native(target));
  assert.equal(
    canonicalizeForPathPolicy(link, false),
    path.join(fs.realpathSync.native(dir), path.basename(link))
  );
});

test('path-policy canonicalization rejects malformed renderer paths', () => {
  assert.throws(() => canonicalizeForPathPolicy(''), /non-empty string/);
  assert.throws(() => canonicalizeForPathPolicy('bad\0path'), /must not contain NUL/);
  assert.throws(() => canonicalizeForPathPolicy('x'.repeat(33 * 1024)), /too long/);
});

test('remove deletes an escaping symlink entry without following its target', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t);
  const link = path.join(dir, 'outside-link');
  fs.symlinkSync('/etc', link);

  fsDispatch(app, 'plugin:fs|remove', {
    args: { path: link, options: { recursive: false } },
  });
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.existsSync('/etc'), true);
});

test('writes use the canonical operation path through an allowed symlink parent', (t) => {
  const dir = tempDir(t);
  const targetDir = tempDir(t);
  const linkDir = path.join(dir, 'linked-parent');
  const targetFile = path.join(targetDir, 'written.txt');
  fs.symlinkSync(targetDir, linkDir);

  fsDispatch(app, 'plugin:fs|write_text_file', {
    body: Buffer.from('canonical'),
    headers: {
      path: encodeURIComponent(path.join(linkDir, 'written.txt')),
      options: '{}',
    },
  });

  assert.equal(fs.readFileSync(targetFile, 'utf8'), 'canonical');
});

test(
  'custom append and atomic writes reject paths below an escaping symlink',
  { skip: process.platform === 'win32' },
  (t) => {
    const dir = tempDir(t);
    const link = path.join(dir, 'outside');
    fs.symlinkSync('/etc', link);
    const escaped = path.join(link, `abu-security-write-${process.pid}`);

    assert.throws(
      () =>
        fsDispatch(app, 'append_file_text', {
          args: { path: escaped, data: 'blocked' },
        }),
      /escapes the allowed scope through a symlink/
    );
    assert.throws(
      () =>
        fsDispatch(app, 'atomic_write_text', {
          args: { path: escaped, content: 'blocked' },
        }),
      /escapes the allowed scope through a symlink/
    );
    assert.equal(fs.existsSync(`/etc/${path.basename(escaped)}`), false);
  }
);

test('atomic writes retry an exclusive random tempfile collision without following its symlink', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'settings.json');
  const sentinel = path.join(dir, 'outside-sentinel.txt');
  const collisionBytes = Buffer.alloc(16, 0x11);
  const retryBytes = Buffer.alloc(16, 0x22);
  const planted = path.join(
    dir,
    `.settings.json.tmp.${process.pid}.${collisionBytes.toString('hex')}`
  );
  fs.writeFileSync(sentinel, 'untouched');
  fs.symlinkSync(sentinel, planted);

  const originalRandomBytes = crypto.randomBytes;
  let randomCalls = 0;
  crypto.randomBytes = (size) => {
    assert.equal(size, 16);
    randomCalls++;
    return randomCalls === 1 ? collisionBytes : retryBytes;
  };
  try {
    fsDispatch(app, 'atomic_write_text', {
      args: { path: target, content: '{"safe":true}' },
    });
  } finally {
    crypto.randomBytes = originalRandomBytes;
  }

  assert.equal(randomCalls, 2, 'the planted first candidate must force one exclusive retry');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"safe":true}');
  assert.equal(fs.lstatSync(planted).isSymbolicLink(), true);
});

test('EXDEV restore replaces a target symlink without writing through it', (t) => {
  const dir = tempDir(t);
  const backup = path.join(dir, '.settings.json.backup.test');
  const target = path.join(dir, 'settings.json');
  const sentinel = path.join(dir, 'outside-sentinel.txt');
  fs.writeFileSync(backup, '{"restored":true}');
  fs.writeFileSync(sentinel, 'untouched');
  fs.symlinkSync(sentinel, target);

  const originalRenameSync = fs.renameSync;
  // Windows may pass the same temp directory once as an 8.3 path and once as
  // its long path. These entry names uniquely identify the restore rename.
  const backupName = path.basename(backup).toLowerCase();
  const targetName = path.basename(target).toLowerCase();
  let forcedExdev = false;
  fs.renameSync = (from, to) => {
    if (
      path.basename(from).toLowerCase() === backupName &&
      path.basename(to).toLowerCase() === targetName
    ) {
      forcedExdev = true;
      const err = new Error('forced cross-device restore');
      err.code = 'EXDEV';
      throw err;
    }
    return originalRenameSync(from, to);
  };
  try {
    fsDispatch(app, 'restore_from_backup', {
      args: { target, backup },
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(forcedExdev, true, 'the test must execute the EXDEV copy fallback');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"restored":true}');
  assert.equal(fs.existsSync(backup), false);
});

test('restore rejects a symlink source instead of copying through it', (t) => {
  const dir = tempDir(t);
  const source = path.join(dir, 'source.txt');
  const backupLink = path.join(dir, '.settings.json.backup.link');
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(source, 'must-not-restore-through-link');
  fs.symlinkSync(source, backupLink);

  assert.throws(
    () =>
      fsDispatch(app, 'restore_from_backup', {
        args: { target, backup: backupLink },
      }),
    /restore source must be a regular file/
  );
  assert.equal(fs.existsSync(target), false);
});

test('backup cleanup rejects invalid TTL values', (t) => {
  const dir = tempDir(t);
  assert.throws(
    () =>
      fsDispatch(app, 'cleanup_old_backups', {
        args: { dir, ttlHours: -1 },
      }),
    /non-negative finite number/
  );
});

test('a different IPC sender cannot close another sender fs watch', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'watch.txt');
  fs.writeFileSync(file, 'watch');
  const owner = new EventEmitter();
  owner.send = () => {};
  const other = new EventEmitter();
  other.send = () => {};

  const rid = fsWatchDispatch(app, 'plugin:fs|watch', {
    args: {
      paths: [file],
      options: { delayMs: 0 },
      onEvent: '__CHANNEL__:1',
    },
    event: { sender: owner },
  });
  t.after(() => {
    fsWatchDispatch(app, 'plugin:resources|close', {
      args: { rid },
      event: { sender: owner },
    });
  });

  assert.throws(
    () =>
      fsWatchDispatch(app, 'plugin:resources|close', {
        args: { rid },
        event: { sender: other },
      }),
    /different IPC sender/
  );
});

test('renderer reload cleanup closes every fs watch owned by that sender', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'reload-watch.txt');
  fs.writeFileSync(file, 'watch');
  const owner = new EventEmitter();
  owner.send = () => {};

  const rid = fsWatchDispatch(app, 'plugin:fs|watch', {
    args: {
      paths: [file],
      options: { delayMs: 0 },
      onEvent: '__CHANNEL__:2',
    },
    event: { sender: owner },
  });
  assert.equal(owner.listenerCount('destroyed'), 1);

  cleanupFsWatchesForSender(owner);

  assert.equal(owner.listenerCount('destroyed'), 0);
  assert.doesNotThrow(() =>
    fsWatchDispatch(app, 'plugin:resources|close', {
      args: { rid },
      event: { sender: owner },
    })
  );
});
