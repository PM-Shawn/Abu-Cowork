'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOperationSession } = require('./pluginOperationSession.cjs');
const { parse: parseYaml } = require('yaml');
const { BUILTIN_AGENT_NAMES } = require('./shared/pluginAgentFormat.mjs');
const { validRecord, safeSegment } = require('./pluginRegistryHost.cjs');

const PLUGIN_OPERATION_CHANNEL = 'abu:plugin-operation';
const MAX_BYTES = 8 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`Plugin operation: ${message}`); };

/**
 * Durable compensation around the existing package/agent installers. The active
 * journal is encrypted, owns exactly one operation, and survives renderer/main
 * restarts. Backups are moved, never overwritten or recursively deleted.
 * Runtime state must be applied and acknowledged before another mutation starts.
 */
function createPluginOperationHost({ home, registry, snapshots, encrypt, decrypt,
  fs = nodeFs.promises, session: providedSession, mutate, randomId = () => crypto.randomBytes(16).toString('hex'),
} = {}) {
  const root = path.resolve(home);
  const operations = path.join(root, '.abu', 'plugin-operations');
  const journal = path.join(operations, 'active.enc');
  let queue = Promise.resolve();
  let owner;
  let closing = false;
  let rootIdentity;
  const session = providedSession ?? (mutate ? null : createOperationSession(root));
  mutate ??= input => session.mutate(input);

  async function stat(file) {
    try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function directory(dir, create = false) {
    const canonical = await fs.realpath(root);
    const identity = await fs.stat(canonical);
    if (!rootIdentity) rootIdentity = { canonical, ino: identity.ino, dev: identity.dev };
    if (canonical !== rootIdentity.canonical || identity.ino !== rootIdentity.ino || identity.dev !== rootIdentity.dev) fail('profile changed');
    const rel = path.relative(root, dir);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('path outside profile');
    let current = canonical;
    for (const name of rel.split(path.sep).filter(Boolean)) {
      current = path.join(current, name);
      const anchor = current === path.join(canonical, '.abu') ? session?.anchors?.abu
        : current === path.join(canonical, '.abu', 'plugin-operations') ? session?.anchors?.operations : undefined;
      if (create && !anchor) { try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
      const before = await stat(current);
      if (anchor && (!before || before.ino !== anchor.ino || before.dev !== anchor.dev)) fail('lease directory changed');
      if (!before) throw Object.assign(new Error('directory missing'), { code: 'ENOENT' });
      if (before.isSymbolicLink() || !before.isDirectory() || await fs.realpath(current) !== current) fail('linked directory refused');
    }
    return current;
  }
  async function read(file) {
    await directory(path.dirname(file));
    const before = await stat(file);
    if (!before) return null;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > MAX_BYTES) fail('invalid journal/file');
    const fd = await fs.open(file, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW || 0) | (nodeFs.constants.O_NONBLOCK || 0));
    try {
      const opened = await fd.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) fail('file changed');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await fd.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const after = await fd.stat();
      const current = await fs.lstat(file);
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev) fail('file changed');
      await directory(path.dirname(file));
      return bytes;
    } finally { await fd.close(); }
  }
  async function save(value) {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > MAX_BYTES) fail('journal size limit exceeded');
    const bytes = encrypt(raw);
    await directory(operations, true);
    await mutate({ home: rootIdentity.canonical, identity: rootIdentity, action: 'write',
      parent: ['.abu', 'plugin-operations'], temp: `${id()}.tmp`, to: 'active.enc', bytes: bytes.toString('base64') });
  }
  function id() {
    const value = randomId();
    if (!/^[a-f0-9]{32}$/.test(value)) fail('invalid operation identity');
    return value;
  }
  function validate(value) {
    if (!plain(value) || value.schema !== 1 || !/^[a-f0-9]{32}$/.test(value.id)
      || !['install', 'update', 'uninstall'].includes(value.kind)
      || !['prepared', 'committed', 'restored'].includes(value.phase)
      || !Array.isArray(value.moves) || value.moves.length > 10000
      || (value.previous !== null && !validRecord(value.previous))
      || (value.next !== null && !validRecord(value.next))) fail('invalid operation journal');
    const record = value.next ?? value.previous;
    if (!record || (value.previous ?? record).key !== value.key || (value.previous && record.marketplace !== value.previous.marketplace)) fail('operation identity mismatch');
    for (const move of value.moves) {
      if (!plain(move) || !['package', 'agent'].includes(move.kind) || !safeSegment(move.name)
        || !safeSegment(move.backup) || typeof move.existed !== 'boolean' || (move.existed && (!plain(move.identity) || !Number.isSafeInteger(move.identity.ino) || !Number.isSafeInteger(move.identity.dev)))) fail('invalid backup entry');
      if (move.kind === 'package' && (![value.previous?.version, value.next?.version].includes(move.name) || (move.packageName !== undefined && ![value.previous?.name, value.next?.name].includes(move.packageName)))) fail('invalid package backup');
      if (move.kind === 'agent' && ![...(value.previous?.contributed.agents ?? []), ...(value.next?.contributed.agents ?? [])].includes(move.name)) fail('invalid agent backup');
    }
    if (value.preservedServers !== undefined && (!Array.isArray(value.preservedServers)
      || value.preservedServers.some(name => ![...(value.previous?.contributed.mcpServers ?? []), ...(value.next?.contributed.mcpServers ?? [])].includes(name)))) fail('invalid preserved servers');
    validateRuntime(value.previousRuntime, value);
    if (value.phase === 'committed') validateRuntime(value.nextRuntime, value, true);
    return value;
  }
  async function load() {
    await session?.ready();
    try {
      const bytes = await read(journal);
      return bytes === null ? null : validate(JSON.parse(decrypt(bytes)));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const packageDir = record => path.join(root, '.abu', 'plugin-packages', record.marketplace, record.name, record.version);
  const target = (op, move) => move.kind === 'package'
    ? packageDir({ ...(op.next ?? op.previous), name: move.packageName ?? (op.next ?? op.previous).name, version: move.name })
    : path.join(root, '.abu', 'agents', move.name);
  const backup = (op, move) => path.join(path.dirname(target(op, move)), `.abu-plugin-backup-${op.id}-${move.backup}`);
  const identityOf = info => info ? { ino: info.ino, dev: info.dev } : null;
  const sameIdentity = (info, identity) => info && identity && info.ino === identity.ino && info.dev === identity.dev && !info.isSymbolicLink();

  async function ownedAgent(dir, key) {
    const info = await stat(dir);
    if (!info) return false;
    await directory(dir);
    const bytes = await read(path.join(dir, 'AGENT.md'));
    const match = bytes?.toString('utf8').match(/^---\s*\n([\s\S]*?)\n---(?:\s|$)/);
    if (!match) return false;
    const metadata = parseYaml(match[1]);
    return metadata?.source === `plugin:${key}`;
  }
  async function moveDirectory(from, to, expected) {
    if (path.dirname(from) !== path.dirname(to)) fail('cross-directory move refused');
    await directory(path.dirname(from));
    const source = await stat(from);
    if (!source || source.isSymbolicLink() || (expected && !sameIdentity(source, expected))) fail('source changed');
    await mutate({ home: rootIdentity.canonical, identity: rootIdentity, action: 'rename',
      parent: path.relative(root, path.dirname(from)).split(path.sep),
      from: path.basename(from), to: path.basename(to), source: identityOf(source) });
  }
  async function records() {
    const raw = await registry.dispatch('read', { home, forWrite: true });
    return raw === null ? [] : JSON.parse(raw);
  }
  const result = op => ({ id: op.id, key: op.phase === 'committed' ? (op.next?.key ?? op.key) : op.key, phase: op.phase, installed: op.phase === 'committed' ? Boolean(op.next) : Boolean(op.previous), expectedRuntime: op.previousRuntime, runtime: op.phase === 'committed' ? op.nextRuntime : op.previousRuntime });

  function validateRuntime(runtime, op, committed = false) {
    if (!plain(runtime) || typeof runtime.enabled !== 'boolean' || !plain(runtime.servers)
      || !plain(runtime.disabledSkills) || !plain(runtime.disabledAgents)) fail('invalid runtime state');
    if (committed && !op.next && runtime.enabled) fail('uninstalled plugin cannot be enabled');
    if (committed) {
      const retained = new Set(op.next?.contributed.mcpServers ?? []);
      for (const name of op.previous?.contributed.mcpServers ?? []) {
        if (!(op.preservedServers ?? []).includes(name) && !retained.has(name) && runtime.servers[name] !== null) fail('removed server must be withdrawn');
      }
      for (const [name, config] of Object.entries(runtime.servers)) {
        if (config !== null && !retained.has(name)) fail('server is not in final installation');
      }
    }
    for (const [field, contribution] of [['servers', 'mcpServers'], ['disabledSkills', 'skills'], ['disabledAgents', 'agents']]) {
      const allowed = new Set([...(op.previous?.contributed[contribution] ?? []), ...(op.next?.contributed[contribution] ?? [])]);
      for (const [name, value] of Object.entries(runtime[field])) {
        if (!allowed.has(name) || (field === 'servers' && (op.preservedServers ?? []).includes(name))) fail('runtime state outside plugin ownership');
        if (field === 'servers') {
          if (value !== null && (!plain(value) || value.name !== name)) fail('invalid server state');
        } else if (typeof value !== 'boolean') fail('invalid child preference');
      }
    }
  }

  async function rollback(op) {
    if (op.phase === 'committed') fail('committed operation must be acknowledged');
    if (op.phase === 'restored') return result(op);
    for (const move of [...op.moves].reverse()) {
      const dest = target(op, move);
      const saved = backup(op, move);
      const savedInfo = await stat(saved);
      const current = await stat(dest);
      // An absent backup means the initial rename never happened, or this
      // specific backup was already restored before interruption.
      if (move.existed && !savedInfo) {
        if (!sameIdentity(current, move.identity)) fail('backup missing and original changed; recovery paused');
        continue;
      }
      if (savedInfo && !sameIdentity(savedInfo, move.identity)) fail('backup changed; recovery paused');
      if (current) {
        if (move.kind === 'agent' && !(await ownedAgent(dest, op.next?.key ?? op.key)) && !(await ownedAgent(dest, op.key))) fail('agent ownership changed; recovery paused');
        if (move.kind === 'package') await directory(dest);
        // Preserve failed new files for diagnosis; do not delete user data.
        await moveDirectory(dest, path.join(path.dirname(dest), `.abu-plugin-retired-${op.id}-${move.backup}`));
      }
      if (savedInfo) await moveDirectory(saved, dest, move.identity);
    }
    if (op.next && op.previous && op.next.key !== op.previous.key) await registry.dispatch('remove', { home, key: op.next.key });
    if (op.previous) await registry.dispatch('upsert', { home, record: op.previous });
    else await registry.dispatch('remove', { home, key: op.key });
    op.phase = 'restored';
    await save(op);
    return result(op);
  }

  async function begin(sender, request) {
    if (await load()) fail('another operation needs completion or recovery');
    if (!plain(request) || Object.keys(request).some(k => !['kind', 'key', 'record', 'token', 'runtime', 'expected'].includes(k))
      || !['install', 'update', 'uninstall'].includes(request.kind)) fail('invalid begin request');
    const installed = await records();
    const previous = installed.find(record => record.key === request.key) ?? null;
    const canonical = value => JSON.stringify(value, (_key, item) => plain(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    const normalized = record => record ? { ...record, contributed: { ...record.contributed, agents: record.contributed.agents ?? [] } } : null;
    if (!Object.hasOwn(request, 'expected') || canonical(normalized(request.expected)) !== canonical(normalized(previous))) fail('installation changed; refresh before retrying');
    if (request.kind === 'install' && previous) fail('already installed');
    if (request.kind !== 'install' && !previous) fail('plugin not installed');
    const next = request.kind === 'uninstall' ? null : request.record;
    if (next) {
      if (!validRecord(next)) fail('invalid install record');
      const verified = await snapshots.identity(sender, { token: request.token });
      if (['name', 'marketplace', 'version', 'checksum', 'authoringId'].some(field => next[field] !== verified[field])) fail('snapshot identity mismatch');
      if (next.key !== request.key && (request.kind !== 'update' || next.marketplace !== previous.marketplace
        || !verified.previousNames?.includes(previous.name) || installed.some(record => record.key === next.key))) fail('unapproved or conflicting plugin rename');
      await registry.dispatch('validate', { home, record: next });
    } else if (request.kind !== 'uninstall') fail('install record missing');
    const op = { schema: 1, id: id(), key: request.key, kind: request.kind, phase: 'prepared',
      token: request.token, previous, next, previousRuntime: request.runtime, nextRuntime: null, moves: [],
      preservedServers: [...new Set(installed.filter(record => record.key !== request.key).flatMap(record => record.contributed.mcpServers))]
        .filter(name => [...(previous?.contributed.mcpServers ?? []), ...(next?.contributed.mcpServers ?? [])].includes(name)) };
    validateRuntime(request.runtime, op);
    const packageRecords = [previous, next].filter((record, index, all) => record && all.findIndex(item => item && packageDir(item) === packageDir(record)) === index);
    for (const packageRecord of packageRecords) {
      const move = { kind: 'package', name: packageRecord.version, packageName: packageRecord.name, backup: `package-${op.moves.length}`, existed: false };
      const current = await stat(target(op, move));
      if (current) {
        await directory(target(op, move));
        if (!previous || packageDir(packageRecord) !== packageDir(previous)) fail('target version already exists');
        move.existed = true;
        move.identity = identityOf(await stat(target(op, move)));
      }
      op.moves.push(move);
    }
    // Directory names alone do not establish ownership: another folder may
    // declare the same agent name, and builtins do not have a disk folder.
    const nextAgents = new Set(next?.contributed.agents ?? []);
    for (const name of nextAgents) {
      if (BUILTIN_AGENT_NAMES.includes(name) || name.startsWith('.abu-plugin-')) fail('agent ownership conflict');
    }
    const agentRoot = path.join(root, '.abu', 'agents');
    if (nextAgents.size && await stat(agentRoot)) {
      await directory(agentRoot);
      for (const folder of await fs.readdir(agentRoot)) {
        if (folder.startsWith('.abu-plugin-')) continue;
        if (!safeSegment(folder)) fail('invalid agent directory');
        const dir = path.join(agentRoot, folder);
        const info = await stat(dir);
        if (!info?.isDirectory() || info.isSymbolicLink()) continue;
        const bytes = await read(path.join(dir, 'AGENT.md'));
        const match = bytes?.toString('utf8').match(/^---\s*\n([\s\S]*?)\n---(?:\s|$)/);
        if (!match) continue;
        const metadata = parseYaml(match[1]);
        if (nextAgents.has(metadata?.name) && !(previous?.contributed.agents?.includes(folder) && folder === metadata.name && metadata.source === `plugin:${request.key}`)) fail('agent ownership conflict');
      }
    }
    const agents = [...new Set([...(previous?.contributed.agents ?? []), ...(next?.contributed.agents ?? [])])];
    for (const name of agents) {
      if (!safeSegment(name)) fail('invalid agent identity');
      const move = { kind: 'agent', name, backup: `agent-${op.moves.length}`, existed: false };
      const dir = target(op, move);
      if (await stat(dir)) {
        if (!previous?.contributed.agents?.includes(name) || !(await ownedAgent(dir, op.key))) {
          if (request.kind === 'uninstall') continue; // Preserve legacy/unowned files.
          fail('agent ownership conflict');
        }
        move.existed = true;
        move.identity = identityOf(await stat(target(op, move)));
      }
      op.moves.push(move);
    }
    validate(op);
    // Encrypt and validate before moving even one existing file.
    await save(op);
    owner = sender;
    try {
      for (const move of op.moves) if (move.existed) await moveDirectory(target(op, move), backup(op, move), move.identity);
    } catch (error) {
      await rollback(op);
      throw error;
    }
    return { id: op.id, previous };
  }
  async function execute(sender, action, request) {
    // Recovery is the user's explicit "get me out of this" action, so it is the
    // one place allowed to restart a session that a worker death closed.
    if (action === 'recover') session?.reopen?.();
    if (action === 'begin') return begin(sender, request);
    const op = await load();
    if (action === 'status') return op ? { id: op.id, key: op.key, phase: op.phase } : null;
    if (action === 'recover') {
      if (!op) return null;
      if (request?.key !== undefined && request.key !== op.key) fail('another plugin operation needs completion');
      if (owner && owner !== sender && !owner.isDestroyed?.()) fail('operation still owned by another window');
      owner = sender;
      return op.phase === 'committed' ? result(op) : rollback(op);
    }
    if (!op || owner !== sender || request?.id !== op.id) fail('operation unavailable or owned by another window');
    if (action === 'rollback') return rollback(op);
    if (action === 'commit') {
      if (op.phase !== 'prepared') fail('operation already resolved');
      const record = request.record ?? null;
      validateRuntime(request.runtime, { ...op, next: record }, true);
      if (op.next) {
        if (!validRecord(record) || ['key', 'name', 'marketplace', 'version', 'checksum'].some(field => record[field] !== op.next[field])) fail('commit identity mismatch');
        for (const type of ['skills', 'agents', 'mcpServers']) {
          if ((record.contributed[type] ?? []).some(name => !op.next.contributed[type]?.includes(name))) fail('unapproved contribution');
        }
        await directory(packageDir(record));
        if (!op.materialized || op.materialized.checksum !== record.checksum || !sameIdentity(await stat(packageDir(record)), op.materialized.identity)) fail('package was not materialized by this operation or changed');
        await snapshots.verifyInstalled(sender, { token: op.token }, record.contributed.agents ?? []);
        for (const name of record.contributed.agents ?? []) {
          if (!(await ownedAgent(path.join(root, '.abu', 'agents', name), record.key))) fail('contributed agent missing or ownership changed');
        }
        await registry.dispatch('upsert', { home, record });
        if (op.previous && op.previous.key !== record.key) await registry.dispatch('remove', { home, key: op.previous.key });
        op.next = record;
      } else {
        if (record !== null) fail('uninstall cannot install a record');
        await registry.dispatch('remove', { home, key: op.key });
      }
      op.nextRuntime = request.runtime;
      op.phase = 'committed';
      await save(op);
      return result(op);
    }
    if (action === 'ack') {
      if (op.phase === 'prepared') fail('operation has not resolved');
      // Keep backup files as retired snapshots. They are outside discovery;
      // no runtime data is implicitly deleted by update or uninstall.
      await directory(operations);
      await moveDirectory(journal, path.join(operations, `completed-${op.id}.enc`));
      owner = undefined;
      return { complete: true };
    }
    fail('unsupported action');
  }
  return {
    external(action, fn) {
      const pending = queue.then(async () => {
        const op = await load();
        if (op && (action !== 'read' && action !== 'validate' || action === 'read' && op.phase === 'prepared')) fail('pending operation must finish before accessing plugins');
        return fn();
      });
      queue = pending.catch(() => {});
      return pending;
    },
    async assertIdle() { if (await load()) fail('pending operation must finish before modifying plugins'); },
    materialize(sender, request) {
      if (closing) return Promise.reject(new Error('Plugin operation: shutting down'));
      const captured = structuredClone(request);
      const pending = queue.then(async () => {
        const op = await load();
        if (!op || owner !== sender || op.token !== captured?.token || op.phase !== 'prepared' || !op.next) fail('snapshot not owned by this operation');
        const value = await snapshots.materialize(sender, captured);
        if (value.checksum !== op.next.checksum || path.resolve(value.targetDir) !== packageDir(op.next)) fail('materialized identity mismatch');
        const agents = await snapshots.materializeAgents(sender, captured, op.next.contributed.agents ?? []);
        await directory(value.targetDir);
        op.materialized = { checksum: value.checksum, identity: identityOf(await stat(value.targetDir)) };
        await save(op);
        return { ...value, agents };
      });
      queue = pending.catch(() => {});
      return pending;
    },
    async shutdown() { closing = true; await queue; await session?.close(); },
    dispatch(sender, action, request = {}) {
      if (closing) return Promise.reject(new Error('Plugin operation: shutting down'));
      const captured = structuredClone(request);
      const pending = queue.then(() => execute(sender, action, captured));
      queue = pending.catch(() => {});
      return pending;
    },
  };
}

module.exports = { PLUGIN_OPERATION_CHANNEL, createPluginOperationHost };
