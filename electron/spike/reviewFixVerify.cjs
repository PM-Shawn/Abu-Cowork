/* Regression harness for the F1a/F4 code-review fixes (plain node):
 *  1. cleanup_old_backups honors the camelCase `ttlHours` wire key (was reading
 *     a.ttl_hours → 0 → deleting EVERY backup regardless of age).
 *  2. A single-FILE watch reports the file's own path, not a doubled
 *     /dir/file/file (Node fs.watch fires filename=basename for file targets). */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fsDispatch } = require('../fsHost.cjs');
const { fsWatchDispatch } = require('../fsWatchHost.cjs');

const app = { getPath: () => os.homedir() };
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ FAIL: ' + m)); };

// ── Fix 1: cleanup_old_backups honors ttlHours ──
(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-cleanup-'));
  const stale = path.join(dir, '.x.json.backup.111');
  const fresh = path.join(dir, '.y.json.backup.222');
  fs.writeFileSync(stale, 's'); fs.writeFileSync(fresh, 'f');
  const old = new Date(Date.now() - 48 * 3600 * 1000); // 48h old
  fs.utimesSync(stale, old, old);
  // Real wire key is camelCase ttlHours (atomicFs.ts:89). Keep <24h backups.
  const removed = fsDispatch(app, 'cleanup_old_backups', { args: { dir, ttlHours: 24 } });
  ok(removed === 1, `cleanup ttlHours=24 removed exactly the 48h-old backup (got ${removed})`);
  ok(!fs.existsSync(stale), 'cleanup: stale backup removed');
  ok(fs.existsSync(fresh), 'cleanup: fresh backup KEPT (not wiped by ttl=0 bug)');
  fs.rmSync(dir, { recursive: true, force: true });
})();

// ── Fix 2: single-file watch → real path, not doubled ──
(() => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.rf-watch-'));
  const file = path.join(dir, 'todo.md');
  fs.writeFileSync(file, 'a');
  const received = [];
  const sender = {
    isDestroyed: () => false,
    send: (_ch, msg) => received.push(msg),
    once: () => {},
    removeListener: () => {},
  };
  const rid = fsWatchDispatch(app, 'plugin:fs|watch', {
    args: { paths: [file], options: { delayMs: 0 }, onEvent: '__CHANNEL__:1' },
    event: { sender },
  });
  ok(typeof rid === 'number', 'file-watch returns a numeric rid');
  // Modify AFTER fs.watch has armed (a same-tick write races the FSEvents setup).
  setTimeout(() => fs.writeFileSync(file, 'bb'), 150);
  setTimeout(() => {
    const paths = received.flatMap((m) => (m.payload && m.payload.message && m.payload.message.paths) || []);
    const doubled = path.join(file, 'todo.md');
    ok(paths.length > 0, `file-watch delivered an event (${paths.length})`);
    ok(paths.includes(file), `file-watch path is the file itself: ${file}`);
    ok(!paths.includes(doubled), 'file-watch path is NOT the doubled /file/file form');
    fsWatchDispatch(app, 'plugin:resources|close', { args: { rid } });
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n[review-fix] ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }, 700);
})();
