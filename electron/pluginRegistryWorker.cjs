'use strict';

const fs = require('node:fs');
const { applyRegistryMutation, prepareRegistryMutation } = require('./pluginRegistryHost.cjs');

/** Pin each path component as cwd and verify the inode reached before writing. */
function enterDirectory(name, create, io = fs, chdir = process.chdir) {
  if (create) {
    try { io.mkdirSync(name); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const before = io.lstatSync(name);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('Plugin registry: linked directory refused');
  chdir(name);
  const after = io.statSync('.');
  if (before.ino !== after.ino || before.dev !== after.dev) throw new Error('Plugin registry: directory changed');
}

const { acquireLease: acquireWriteLock } = require('./pluginLease.cjs');

function run(input, io = fs, chdir = process.chdir, randomId) {
  const cwd = io.statSync('.');
  if (cwd.ino !== input.identity.ino || cwd.dev !== input.identity.dev) throw new Error('Plugin registry: profile changed');
  const create = input.action === 'upsert';
  try {
    enterDirectory('.abu', create, io, chdir);
    enterDirectory('plugin-packages', create, io, chdir);
  } catch (e) {
    if (!create && e.code === 'ENOENT') {
      if (input.action === 'validate') prepareRegistryMutation(null, 'validate', input.request);
      return;
    }
    throw e;
  }
  const release = acquireWriteLock(io, chdir);
  try { applyRegistryMutation(input.action, input.request, { fs: io, randomId }); }
  finally { release(); }

}

if (require.main === module) {
  try {
    // Input is supplied only by the parent service, with the already checked profile identity.
    const input = fs.readFileSync(0, 'utf8');
    if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw new Error('Plugin registry: request size limit exceeded');
    run(JSON.parse(input));
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
}

module.exports = { enterDirectory, acquireWriteLock, run };
