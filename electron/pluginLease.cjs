'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

const isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
const same = (a, b) => a && b && a.ino === b.ino && a.dev === b.dev && !a.isSymbolicLink?.();
const busy = () => Object.assign(new Error('Plugin registry: another write is active or interrupted; recovery required'), { code: 'PLUGIN_LEASE_BUSY' });

/** Publish and retire a NONEMPTY lock atomically. Retired locks are intentionally
 * retained: their deterministic name prevents a second stale reclaimer from
 * renaming a newer live lock (rename onto a nonempty directory must fail).
 */
function acquireLease(io = fs, chdir = process.chdir, pid = process.pid, alive = isAlive,
  nonce = () => crypto.randomBytes(16).toString('hex')) {
  const token = nonce();
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Plugin registry: invalid lease identity');
  const parent = io.statSync('.');
  const lock = '.installed-write-lock';
  const prepared = `.installed-lock-prepared-${token}`;
  const marker = `owner-${pid}-${token}`;
  function syncDirectory() {
    let fd;
    try { fd = io.openSync('.', 'r'); io.fsyncSync(fd); }
    catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
    finally { if (fd !== undefined) io.closeSync(fd); }
  }
  function enter(name) {
    const before = io.lstatSync(name);
    if (before.isSymbolicLink() || !before.isDirectory()) throw busy();
    chdir(name);
    if (!same(before, io.statSync('.'))) throw busy();
  }
  function leave() {
    chdir('..');
    if (!same(parent, io.statSync('.'))) throw busy();
  }
  function inspect() {
    const identity = io.lstatSync(lock);
    enter(lock);
    try {
      const names = io.readdirSync('.');
      const match = names.length === 1 && /^owner-([1-9][0-9]*)(?:-([a-f0-9]{32}))?$/.exec(names[0]);
      if (!match) throw busy();
      const info = io.lstatSync(names[0]);
      const owner = Number(match[1]);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 0 || !Number.isSafeInteger(owner)) throw busy();
      return { identity, owner, token: match[2] ?? `legacy-${owner}-${identity.dev}-${identity.ino}` };
    } catch { throw busy(); } finally { leave(); }
  }
  try { const existing = inspect(); if (alive(existing.owner)) throw busy(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  io.mkdirSync(prepared);
  enter(prepared);
  try {
    const fd = io.openSync(marker, 'wx', 0o600);
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    syncDirectory();
  } finally { leave(); }
  for (let attempt = 0; attempt < 8; attempt++) {
    let existing;
    try { existing = inspect(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (alive(existing.owner)) throw busy();
      if (!same(existing.identity, io.lstatSync(lock))) continue;
      try { io.renameSync(lock, `.installed-lock-retired-${existing.token}`); syncDirectory(); }
      catch (error) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      continue;
    }
    try { io.renameSync(prepared, lock); }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) continue;
      throw error;
    }
    syncDirectory();
    const identity = io.lstatSync(lock);
    let released = false;
    return () => {
      if (released) return;
      if (!same(identity, io.lstatSync(lock))) throw busy();
      io.renameSync(lock, `.installed-lock-retired-${token}`);
      released = true;
      syncDirectory();
    };
  }
  throw busy();
}
module.exports = { acquireLease };
