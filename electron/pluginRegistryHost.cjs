'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PLUGIN_REGISTRY_CHANNEL = 'abu:plugin-registry';
const MAX_BYTES = 4 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.length <= 10000 && value.every(v => typeof v === 'string' && v.length <= 4096);
function safeSegment(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && value.trim() === value
    && !/[/\\\x00-\x1f\x7f<>:"|?*]/.test(value) && !/[. ]$/.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function validRecord(record) {
  return plain(record) && safeSegment(record.name) && safeSegment(record.marketplace) && safeSegment(record.version)
    && record.key === `${record.name}@${record.marketplace}`
    && plain(record.contributed) && strings(record.contributed.skills) && strings(record.contributed.mcpServers)
    && (record.contributed.agents === undefined || strings(record.contributed.agents));
}
function validateRecords(records) {
  if (!Array.isArray(records) || records.length > 10000 || records.some(record => !validRecord(record))
    || new Set(records.map(record => record.key)).size !== records.length) {
    throw new Error('Plugin registry: invalid or duplicate installed record; refusing to overwrite');
  }
}

function registryIO(fs, randomId) {
  function read(file) {
    let before;
    try { before = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) throw new Error('Plugin registry: linked/non-regular file refused');
    if (before.size > MAX_BYTES) throw new Error('Plugin registry: size limit exceeded');
    const fd = fs.openSync(file, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW || 0) | (nodeFs.constants.O_NONBLOCK || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('Plugin registry: file changed');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      const after = fs.fstatSync(fd);
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Plugin registry: file changed');
      const current = fs.lstatSync(file);
      if (current.isSymbolicLink() || current.ino !== opened.ino || current.dev !== opened.dev) throw new Error('Plugin registry: file changed');
      return bytes.toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  function write(file, raw) {
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Plugin registry: size limit exceeded');
    const id = randomId();
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Plugin registry: invalid temporary identity');
    const temporary = path.join(path.dirname(file), `.installed-${id}.tmp`);
    let fd; let created = false;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600); created = true;
      fs.writeFileSync(fd, raw, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, file);
    } catch (error) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Preserve the original failure. */ } }
      // Never remove a pre-existing file when exclusive creation failed.
      if (created) { try { fs.unlinkSync(temporary); } catch { /* A leftover temporary is not authoritative. */ } }
      throw error;
    }
  }

  return { read, write };
}

/** Pure prospective validation shared by existing and not-yet-created registries. */
function prepareRegistryMutation(raw, action, request) {
  const records = raw === null ? [] : JSON.parse(raw);
  validateRecords(records);
  if (action === 'upsert' || action === 'validate') {
    if (!validRecord(request.record)) throw new Error('Plugin registry: invalid record');
    const index = records.findIndex(record => record.key === request.record.key);
    if (index < 0) records.push(request.record); else records[index] = request.record;
  } else if (action === 'remove') {
    const index = records.findIndex(record => record.key === request.key);
    if (index < 0) return;
    records.splice(index, 1);
  } else throw new Error('Plugin registry: unsupported mutation');
  validateRecords(records);
  const serialized = JSON.stringify(records, null, 2);
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Plugin registry: size limit exceeded');
  return serialized;
}

/** Called only after the worker has pinned its cwd to the verified directory. */
function applyRegistryMutation(action, request, { fs = nodeFs, randomId = () => crypto.randomBytes(16).toString('hex'), file = 'installed.json' } = {}) {
  const { read, write } = registryIO(fs, randomId);
  const serialized = prepareRegistryMutation(read(file), action, request);
  if (action !== 'validate' && serialized !== undefined) write(file, serialized);
}

function runMutationWorker({ action, request, home, identity }) {
  // Relative filesystem operations use the worker's inode-bound cwd without
  // changing Electron main's global cwd or blocking its event loop.
  const input = JSON.stringify({ action, request, identity });
  if (Buffer.byteLength(input) > MAX_BYTES) throw new Error('Plugin registry: request size limit exceeded');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'pluginRegistryWorker.cjs')], {
      cwd: home, env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true,
    });
    let errorText = ''; let failed = false;
    child.stderr.on('data', bytes => { errorText = (errorText + bytes.toString()).slice(0, 4096); });
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => { /* The close event determines the result. */ });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && !failed) resolve();
      else reject(new Error(errorText || 'Plugin registry: mutation worker interrupted; reload installation status'));
    });
    child.stdin.end(input);
  });
}

/** One instance per Electron profile. This coordinates metadata, not the package lifecycle. */
function createPluginRegistryHost({ home, fs = nodeFs, mutate = runMutationWorker } = {}) {
  const lexicalHome = path.resolve(home);
  const canonicalHome = fs.realpathSync(lexicalHome);
  const homeIdentity = fs.statSync(canonicalHome);
  const { read } = registryIO(fs);
  let queue = Promise.resolve();
  let closing = false;

  function directory(dir) {
    const before = fs.lstatSync(dir);
    if (before.isSymbolicLink() || !before.isDirectory() || fs.realpathSync(dir) !== dir) throw new Error('Plugin registry: linked directory refused');
    return dir;
  }

  function profile(requestHome) {
    if (typeof requestHome !== 'string' || !path.isAbsolute(requestHome) || requestHome.includes('\0')) throw new Error('Plugin registry: invalid profile');
    const currentHome = fs.realpathSync(lexicalHome);
    const currentIdentity = fs.statSync(currentHome);
    if (currentHome !== canonicalHome || currentIdentity.ino !== homeIdentity.ino || currentIdentity.dev !== homeIdentity.dev) throw new Error('Plugin registry: profile changed');
    // Accept only the configured profile's lexical or canonical spelling.
    if (![lexicalHome, canonicalHome].includes(path.resolve(requestHome))) throw new Error('Plugin registry: profile mismatch');
    return canonicalHome;
  }

  function location(canonicalHome) {
    const abu = directory(path.join(canonicalHome, '.abu'));
    return path.join(directory(path.join(abu, 'plugin-packages')), 'installed.json');
  }


  function execute(action, request) {
    const allowed = action === 'read' ? ['home', 'forWrite'] : (action === 'upsert' || action === 'validate') ? ['home', 'record'] : action === 'remove' ? ['home', 'key'] : null;
    if (!allowed || !plain(request) || Object.keys(request).some(key => !allowed.includes(key))) throw new Error('Plugin registry: unsupported request');
    if (action === 'read' && request.forWrite !== undefined && typeof request.forWrite !== 'boolean') throw new Error('Plugin registry: invalid read mode');
    if ((action === 'upsert' || action === 'validate') && !validRecord(request.record)) throw new Error('Plugin registry: invalid record');
    if (action === 'remove' && (typeof request.key !== 'string' || request.key.length > 481 || !request.key.includes('@'))) throw new Error('Plugin registry: invalid key');
    const canonicalHome = profile(request.home);
    if (action !== 'read') {
      return mutate({ action, request, home: canonicalHome, identity: { dev: homeIdentity.dev, ino: homeIdentity.ino } });
    }
    let file;
    try { file = location(canonicalHome); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    const parent = path.dirname(file);
    const before = fs.lstatSync(parent);
    const raw = read(file);
    // Reads are bounded descriptor reads. Before exposing bytes, verify that
    // the path still names the same owned directory (including all ancestors).
    location(canonicalHome);
    const after = fs.lstatSync(parent);
    if (after.ino !== before.ino || after.dev !== before.dev) throw new Error('Plugin registry: directory changed');
    if (request.forWrite && raw !== null) validateRecords(JSON.parse(raw));
    return raw;
  }

  return {
    shutdown() { closing = true; return queue; },
    dispatch(action, request) {
      if (closing) return Promise.reject(new Error('Plugin registry: shutting down'));
      // Capture request values at entry; later renderer changes cannot affect a queued write.
      let captured;
      try { captured = structuredClone(request); } catch { return Promise.reject(new Error('Plugin registry: invalid request')); }
      const pending = queue.then(() => {
        if (closing) throw new Error('Plugin registry: shutting down');
        return execute(action, captured);
      });
      queue = pending.catch(() => {});
      return pending;
    },
  };
}

module.exports = { registryIO, PLUGIN_REGISTRY_CHANNEL, createPluginRegistryHost, applyRegistryMutation, prepareRegistryMutation, validRecord, safeSegment };
