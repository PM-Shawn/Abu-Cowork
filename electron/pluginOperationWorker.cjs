'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { enterDirectory } = require('./pluginRegistryWorker.cjs');
const same = (a, b) => a && b && a.ino === b.ino && a.dev === b.dev;
const { safeSegment: segment } = require('./pluginRegistryHost.cjs');

/** All mutations use single-component paths relative to an inode-pinned cwd. */
function run(input, io = fs, chdir = process.chdir) {
  if (!same(io.statSync('.'), input.identity)) throw new Error('Plugin operation: profile changed');
  if (!Array.isArray(input.parent) || !input.parent.every(segment)) throw new Error('Plugin operation: invalid parent');
  for (const part of input.parent) enterDirectory(part, true, io, chdir);
  const parent = io.statSync('.');
  if (input.parentIdentity && !same(parent, input.parentIdentity)) throw new Error('Plugin operation: parent changed');
  if (input.action === 'ensure') {
    // Parent components were created and pinned one at a time above.
  } else if (input.action === 'tree') {
    if (!segment(input.temp) || !segment(input.to) || !Array.isArray(input.tree) || input.tree.length > 10000) throw new Error('Plugin operation: invalid tree');
    let total = 0;
    const entries = input.tree.map(([relative, encoded]) => {
      if (typeof relative !== 'string' || !relative.split('/').every(segment) || relative.split('/').length > 65) throw new Error('Plugin operation: invalid tree path');
      const bytes = encoded === null ? null : Buffer.from(encoded, 'base64');
      if (bytes && (bytes.length > 32 * 1024 * 1024 || (total += bytes.length) > 200 * 1024 * 1024)) throw new Error('Plugin operation: tree too large');
      return [relative.split('/'), bytes];
    });
    const base = process.cwd();
    const reset = () => { chdir(base); if (!same(parent, io.statSync('.'))) throw new Error('Plugin operation: parent changed'); };
    try { io.lstatSync(input.to); throw new Error('Plugin operation: destination exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    io.mkdirSync(input.temp);
    const identities = new Map([['', io.lstatSync(input.temp)]]);
    for (const [parts, bytes] of entries) {
      reset(); enterDirectory(input.temp, false, io, chdir);
      if (!same(identities.get(''), io.statSync('.'))) throw new Error('Plugin operation: staging changed');
      for (let i = 0; i < parts.length - 1; i++) {
        enterDirectory(parts[i], false, io, chdir);
        if (!same(identities.get(parts.slice(0, i + 1).join('/')), io.statSync('.'))) throw new Error('Plugin operation: tree directory changed');
      }
      const name = parts.at(-1);
      if (bytes === null) { io.mkdirSync(name); identities.set(parts.join('/'), io.lstatSync(name)); }
      else {
        const fd = io.openSync(name, 'wx', 0o600);
        try { io.writeFileSync(fd, bytes); io.fsyncSync(fd); } finally { io.closeSync(fd); }
      }
    }
    reset();
    const staged = io.lstatSync(input.temp);
    if (staged.isSymbolicLink() || !same(staged, identities.get(''))) throw new Error('Plugin operation: staging changed');
    try { io.lstatSync(input.to); throw new Error('Plugin operation: destination exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    io.renameSync(input.temp, input.to);
  } else if (input.action === 'rename' || input.action === 'archive') {
    if (!segment(input.from) || !segment(input.to)) throw new Error('Plugin operation: invalid move');
    const before = io.lstatSync(input.from);
    if (before.isSymbolicLink() || !same(before, input.source)) throw new Error('Plugin operation: source changed');
    if (input.action === 'archive') {
      if (input.parent.join('/') !== '.abu/plugin-operations' || input.from !== 'active.enc'
        || !/^corrupt-\d+\.enc$/.test(input.to) || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new Error('Plugin operation: invalid archive');
      if (!before.isFile() || before.nlink > 1 || before.size > 8 * 1024 * 1024) throw new Error('Plugin operation: invalid archive source');
      const fd = io.openSync(input.from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      try {
        const opened = io.fstatSync(fd);
        if (!same(before, opened) || opened.size !== before.size) throw new Error('Plugin operation: archive source changed');
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = io.readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!count) break;
          offset += count;
        }
        const after = io.fstatSync(fd);
        const current = io.lstatSync(input.from);
        if (offset !== before.size || !same(current, before) || current.isSymbolicLink()
          || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || crypto.createHash('sha256').update(bytes).digest('hex') !== input.fingerprint) throw new Error('Plugin operation: archive source changed; refresh before archiving');
      } finally { io.closeSync(fd); }
    }
    try { io.lstatSync(input.to); throw new Error('Plugin operation: destination exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    io.renameSync(input.from, input.to);
  } else if (input.action === 'write') {
    if (!segment(input.temp) || input.to !== 'active.enc') throw new Error('Plugin operation: invalid journal target');
    const bytes = Buffer.from(input.bytes, 'base64');
    if (bytes.length > 9 * 1024 * 1024) throw new Error('Plugin operation: journal too large');
    const fd = io.openSync(input.temp, 'wx', 0o600);
    try { io.writeFileSync(fd, bytes); io.fsyncSync(fd); } finally { io.closeSync(fd); }
    io.renameSync(input.temp, input.to);
  } else throw new Error('Plugin operation: unsupported mutation');
  if (!same(parent, io.statSync('.'))) throw new Error('Plugin operation: directory changed');
  // Directory fsync makes a completed rename durable on platforms supporting it.
  // Windows is not one of them; see pluginLease.syncDirectory.
  if (process.platform === 'win32') return;
  let fd;
  try { fd = io.openSync('.', 'r'); io.fsyncSync(fd); } catch (e) {
    if (!['EINVAL', 'EPERM', 'EACCES', 'EBADF', 'EISDIR', 'ENOTSUP'].includes(e.code)) throw e;
  } finally { if (fd !== undefined) io.closeSync(fd); }
}
function mutate({ home, ...input }) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'pluginOperationWorker.cjs')], { cwd: home, env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let message = ''; let timedOut = false;
    child.stderr.on('data', bytes => { message = (message + bytes.toString()).slice(0, 4096); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.once('close', code => { clearTimeout(timer); code === 0 && !timedOut ? resolve() : reject(new Error(message || 'Plugin operation: mutation interrupted')); });
    child.stdin.end(JSON.stringify(input));
  });
}
if (require.main === module) {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (Buffer.byteLength(raw) > 300 * 1024 * 1024) throw new Error('Plugin operation: oversized mutation');
    run(JSON.parse(raw));
  } catch (e) { process.stderr.write(e.message); process.exitCode = 1; }
}
module.exports = { run, mutate };
