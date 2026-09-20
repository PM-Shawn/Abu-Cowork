'use strict';

const fs = require('node:fs');
const { applyRegistryMutation, prepareRegistryMutation } = require('./pluginRegistryHost.cjs');
const { identityOf, sameIdentity } = require('./fileIdentity.cjs');

/** Pin each path component as cwd and verify the inode reached before writing. */
function enterDirectory(name, create, io = fs, chdir = process.chdir) {
  if (create) {
    try { io.mkdirSync(name); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const before = io.lstatSync(name, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('Plugin registry: linked directory refused');
  chdir(name);
  const after = io.statSync('.', { bigint: true });
  if (!sameIdentity(identityOf(before), identityOf(after))) throw new Error('Plugin registry: directory changed');
}

const { acquireLease: acquireWriteLock } = require('./pluginLease.cjs');

function run(input, io = fs, chdir = process.chdir, randomId) {
  // `input.identity` crossed JSON to get here, so it carries the decimal
  // strings `electron/fileIdentity.cjs` documents; the cwd is read as bigint to
  // compare against them exactly.
  const cwd = io.statSync('.', { bigint: true });
  if (!sameIdentity(identityOf(cwd), identityOf(input.identity))) throw new Error('Plugin registry: profile changed');
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
