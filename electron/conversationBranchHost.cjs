'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { z } = require('zod');
const { createNativeFileSession } = require('./nativeHelperManager.cjs');
const { identityOf, sameIdentity } = require('./fileIdentity.cjs');
const {
  prepareBranchFiles, copyBranchFiles, readPinnedFile, readManifestHistory,
  inspectPath, assertRoot, MAX_FILE_BYTES,
} = require('./conversationBranchFiles.cjs');
const {
  assertConversationId, assertBranchRelativePath, buildConversationBranchHistory,
  conversationBranchPrefix, serializeLedgerPut, projectLedger, decodeLedgerPrefix,
  getConversationBranchEligibility, sanitizeLoadedLedgerMessages,
} = require('./generated/conversationBranch.cjs');

const CHANNEL = 'abu:conversation-branch';
const RECOVERY = 'branch-recovery.json';
const id = z.string().min(1).max(128).superRefine((value, context) => {
  try { assertConversationId(value); } catch { context.addIssue({ code: 'custom', message: 'Invalid conversation ID' }); }
});
const identitySchema = z.object({ sourceConversationId: id, targetMessageId: z.string().min(1).max(1024), childConversationId: id }).strict();
const modelSchema = z.object({ providerId: z.string().min(1).max(1024), modelId: z.string().min(1).max(1024) }).strict();
const prepareSchema = identitySchema.extend({
  watermark: z.number().int().positive().max(MAX_FILE_BYTES),
  prefix: z.string().min(1).max(MAX_FILE_BYTES), title: z.string().min(1).max(10000), model: modelSchema.optional(),
  errorEmptyBody: z.string().max(10000),
});
const checksumSchema = z.object({ relPath: z.string(), size: z.number().int().nonnegative().max(MAX_FILE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const recoverySchema = identitySchema.extend({
  version: z.literal(1), meta: z.record(z.string(), z.unknown()), messageCount: z.number().int().positive(),
  files: z.array(checksumSchema).max(100000),
});
function fail(code) { const error = new Error(`Conversation branch: ${code}`); error.code = code; throw error; }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function operationReceipt(request) {
  return `${request.childConversationId}.${digest(JSON.stringify([request.sourceConversationId, request.targetMessageId]))}.operation`;
}
function sameOrigin(meta, request) {
  return meta?.id === request.childConversationId
    && meta.branchOrigin?.sourceConversationId === request.sourceConversationId
    && meta.branchOrigin?.sourceMessageId === request.targetMessageId;
}

/** All mutations are addressed by checked IDs; renderer paths never enter this module. */
function createConversationBranchHost({ appDataDir, now = Date.now, createId = () => crypto.randomUUID() }) {
  const prepared = new Map();
  const published = new Map();
  const queues = new Map();
  let commitTail = Promise.resolve();
  function serializeCommit(work) {
    const result = commitTail.then(work, work);
    commitTail = result;
    return result;
  }

  function serial(key, work) {
    const previous = queues.get(key);
    const result = (previous ? previous.then(work, work) : Promise.resolve().then(work));
    queues.set(key, result);
    void result.then(() => { if (queues.get(key) === result) queues.delete(key); }, () => { if (queues.get(key) === result) queues.delete(key); });
    return result;
  }
  async function rootState() {
    const root = await fs.promises.realpath(appDataDir);
    const rootIdentity = identityOf(await fs.promises.lstat(root, { bigint: true }));
    await assertRoot(root, rootIdentity);
    return { root, rootIdentity };
  }
  async function readText(state, relative, required = true) {
    const chunks = [];
    const record = await readPinnedFile(state.root, state.rootIdentity, relative, null, MAX_FILE_BYTES,
      chunk => chunks.push(Buffer.from(chunk)));
    if (!record) { if (required) fail('unavailable'); return null; }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  }
  async function index(state) {
    const text = await readText(state, 'conversations/index.json', false);
    if (text === null) return {};
    const value = JSON.parse(text);
    if (value.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) fail('invalid-index');
    return value.entries;
  }
  async function writeNew(state, relative, bytes) {
    assertBranchRelativePath(relative);
    if (bytes.length > MAX_FILE_BYTES) fail('file-too-large');
    const filename = path.join(state.root, relative);
    const target = { path: filename, purpose: 'write', followFinalSymlink: false };
    const session = createNativeFileSession([target]);
    try {
      if (await inspectPath(state.root, relative)) fail('destination-exists');
      const observed = await session.request('observe', target);
      if (observed.exists || path.resolve(observed.canonicalPath) !== filename) fail('unsafe-directory');
      await assertRoot(state.root, state.rootIdentity);
      for (let offset = 0; offset < bytes.length || offset === 0; offset += 256 * 1024) {
        const chunk = bytes.subarray(offset, offset + 256 * 1024);
        await session.request('write-chunk', { reference: observed.reference, offset, bytes: [...chunk] });
      }
      await session.request('finish-write', { reference: observed.reference, size: bytes.length });
    } finally { await session.release(); }
    const checked = await readPinnedFile(state.root, state.rootIdentity, relative, null, MAX_FILE_BYTES);
    if (!checked || checked.sha256 !== digest(bytes)) fail('write-mismatch');
    return { relPath: relative, size: bytes.length, sha256: checked.sha256 };
  }
  async function removeEntry(state, parentRelative, name) {
    const relative = `${parentRelative}/${name}`;
    if (!await inspectPath(state.root, relative)) return;
    const target = { path: path.join(state.root, parentRelative), purpose: 'write', followFinalSymlink: false };
    const session = createNativeFileSession([target]);
    try {
      const observed = await session.request('observe', target);
      if (!observed.isDirectory || observed.isSymlink || path.resolve(observed.canonicalPath) !== target.path) fail('unsafe-directory');
      await assertRoot(state.root, state.rootIdentity);
      await session.request('branch-remove', { reference: observed.reference, name });
    } finally { await session.release(); }
  }
  async function moveDirectory(state, childId) {
    const source = { path: path.join(state.root, 'conversation-branches', childId), purpose: 'list', followFinalSymlink: false };
    const inspect = createNativeFileSession([source]);
    let identity;
    try {
      const observed = await inspect.request('observe', source);
      if (!observed.isDirectory || observed.isSymlink || path.resolve(observed.canonicalPath) !== source.path) fail('unsafe-directory');
      identity = observed.identity;
    } finally { await inspect.release(); }
    const targets = ['conversation-branches', 'conversations'].map(relative => ({ path: path.join(state.root, relative), purpose: 'write', followFinalSymlink: false }));
    const session = createNativeFileSession(targets);
    try {
      const observations = [];
      for (const target of targets) {
        const observed = await session.request('observe', target);
        if (!observed.isDirectory || observed.isSymlink || path.resolve(observed.canonicalPath) !== target.path) fail('unsafe-directory');
        observations.push(observed);
      }
      await assertRoot(state.root, state.rootIdentity);
      await session.request('branch-move', { reference: observations[0].reference, destination: observations[1].reference, name: childId, identity });
    } finally { await session.release(); }
  }
  async function cleanStalePreparations(state) {
    const directory = await inspectPath(state.root, 'conversation-branches');
    if (!directory) return [];
    if (!directory.isDirectory()) fail('unsafe-directory');
    const names = await fs.promises.readdir(path.join(state.root, 'conversation-branches'));
    const failures = [];
    for (const name of names) {
      const match = /^(.+)\.[a-f0-9]{64}\.operation$/.exec(name);
      if (!match || !id.safeParse(match[1]).success || prepared.has(match[1])) continue;
      const childId = match[1];
      try {
        if (await inspectPath(state.root, `conversations/${childId}`)) continue;
        const receipt = await inspectPath(state.root, `conversation-branches/${name}`);
        if (!receipt?.isFile() || receipt.size !== 0n || receipt.nlink !== 1n
          || names.some(other => other !== name && other.startsWith(`${childId}.`) && other.endsWith('.operation'))) fail('identity-conflict');
        await removeEntry(state, 'conversation-branches', childId);
        await removeEntry(state, 'conversation-branches', name);
      } catch (error) {
        failures.push(childId);
        console.error('[conversation-branch] Preparation cleanup failed', childId, error.code ?? error.name);
      }
    }
    return failures;
  }
  async function assertPreparationIdentity(state, request) {
    const receipt = operationReceipt(request);
    const directory = await inspectPath(state.root, 'conversation-branches');
    if (!directory) return;
    if (!directory.isDirectory()) fail('unsafe-directory');
    const names = await fs.promises.readdir(path.join(state.root, 'conversation-branches'));
    if (names.some(name => name.startsWith(`${request.childConversationId}.`) && name.endsWith('.operation') && name !== receipt)) fail('identity-conflict');
    const reserved = await inspectPath(state.root, `conversation-branches/${receipt}`);
    if (reserved && (!reserved.isFile() || reserved.size !== 0n || reserved.nlink !== 1n)) fail('identity-conflict');
    if (await inspectPath(state.root, `conversation-branches/${request.childConversationId}`) && !reserved) fail('identity-conflict');
  }
  async function readHistory(state, sourceId, watermark) {
    const relative = `conversations/${sourceId}/messages.jsonl`;
    const before = await inspectPath(state.root, relative);
    if (!before?.isFile() || before.nlink !== 1n || before.size < BigInt(watermark)) fail('invalid-history');
    const filename = path.join(state.root, relative);
    const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(identityOf(before), identityOf(opened)) || await fs.promises.realpath(filename) !== filename) fail('source-changed');
      const bytes = Buffer.alloc(watermark);
      let offset = 0;
      while (offset < watermark) {
        const result = await handle.read(bytes, offset, watermark - offset, offset);
        if (!result.bytesRead) fail('source-changed');
        offset += result.bytesRead;
      }
      const after = await inspectPath(state.root, relative);
      if (!after || !sameIdentity(identityOf(after), identityOf(opened)) || after.size < BigInt(watermark)) fail('source-changed');
      await assertRoot(state.root, state.rootIdentity);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const result = projectLedger({ ledgerText: decodeLedgerPrefix(bytes, watermark) });
      if (result.corruptCount) fail('invalid-history');
      return result.messages;
    } finally { await handle.close(); }
  }
  async function validateRecovery(state, childId, text) {
    const recovery = recoverySchema.parse(JSON.parse(text));
    if (recovery.childConversationId !== childId || !sameOrigin(recovery.meta, recovery)
      || recovery.meta.messageCount !== recovery.messageCount) fail('invalid-recovery');
    const seen = new Set();
    for (const file of recovery.files) {
      assertBranchRelativePath(file.relPath);
      if (file.relPath === RECOVERY || seen.has(file.relPath)) fail('invalid-recovery');
      seen.add(file.relPath);
      const checked = await readPinnedFile(state.root, state.rootIdentity, `conversations/${childId}/${file.relPath}`, null, MAX_FILE_BYTES);
      if (!checked || Number(checked.size) !== file.size || checked.sha256 !== file.sha256) fail('invalid-recovery');
    }
    if (!seen.has('messages.jsonl') || !seen.has('outputs/manifest.json')) fail('invalid-recovery');
    const projection = projectLedger({ ledgerText: await readText(state, `conversations/${childId}/messages.jsonl`) });
    if (projection.corruptCount || projection.messages.length !== recovery.messageCount
      || projection.messages.at(-1)?.id !== recovery.meta.branchOrigin.inheritedThroughMessageId) fail('invalid-recovery');
    return recovery;
  }
  async function lookup(state, request) {
    const childId = request.childConversationId;
    const directory = await inspectPath(state.root, `conversations/${childId}`);
    if (!directory) {
      if (published.has(childId)) fail('branch-deleted');
      return { state: 'absent' };
    }
    if (!directory.isDirectory()) fail('destination-exists');
    const text = await readText(state, `conversations/${childId}/${RECOVERY}`, false);
    if (text !== null) {
      const recovery = await validateRecovery(state, childId, text);
      if (!sameOrigin(recovery.meta, request)) fail('identity-conflict');
      return { state: 'committed', meta: recovery.meta };
    }
    const meta = (await index(state))[childId];
    if (!sameOrigin(meta, request)) fail('identity-conflict');
    published.set(childId, meta);
    return { state: 'published', meta };
  }
  async function prepare(state, request) {
    const existing = await lookup(state, request);
    if (existing.state !== 'absent') return existing;
    const previous = prepared.get(request.childConversationId);
    if (previous) {
      if (!isDeepStrictEqual(previous.request, request)) fail('operation-in-progress');
      return { state: 'prepared', token: previous.token };
    }
    await assertPreparationIdentity(state, request);
    const cleanupFailures = await serializeCommit(() => cleanStalePreparations(state));
    if (cleanupFailures.includes(request.childConversationId)) fail('preparation-cleanup-failed');
    const sourceMeta = (await index(state))[request.sourceConversationId];
    if (!sourceMeta || sourceMeta.id !== request.sourceConversationId) fail('unavailable');
    const original = await readHistory(state, request.sourceConversationId, request.watermark);
    const eligibility = getConversationBranchEligibility(original, request.targetMessageId, true, 'saved');
    if (!eligibility.eligible) fail(eligibility.reason);
    const text = { errorEmptyBody: request.errorEmptyBody };
    const messages = sanitizeLoadedLedgerMessages(original, { text });
    const entries = await readManifestHistory(state.root, state.rootIdentity, request.sourceConversationId);
    const find = (_id, toolId) => entries.findLast(entry => entry.originalPath === `tool-result://${toolId}`
      && entry.source === 'tool-output' && entry.refId === toolId && entry.refKind === 'result-image' && entry.snapshotRelPath && !entry.missing) ?? null;
    const actual = conversationBranchPrefix(messages, request.sourceConversationId, request.targetMessageId, find, text);
    if (!isDeepStrictEqual(JSON.parse(request.prefix), JSON.parse(actual))) fail('source-changed');
    const history = buildConversationBranchHistory({ ...request, sourceTitle: sourceMeta.title, messages, accessAllowed: true, createId });
    const files = await prepareBranchFiles({ appDataDir: state.root, ...request, messages: history.messages, messageIdMap: history.messageIdMap });
    const timestamp = now();
    const meta = {
      id: request.childConversationId, title: request.title, createdAt: timestamp, updatedAt: timestamp,
      lastUserMessageAt: timestamp, messageCount: files.plan.messages.length,
      branchOrigin: history.branchOrigin, branchInitialOpenPending: true,
    };
    for (const key of ['workspacePath', 'projectId', 'permissionMode', 'enabledMCPServers', 'teamId', 'importedFrom', 'readOnly']) {
      if (Object.hasOwn(sourceMeta, key)) meta[key] = sourceMeta[key];
    }
    if (sourceMeta.model ?? request.model) meta.model = sourceMeta.model ?? request.model;
    if (sourceMeta.appBinding) {
      meta.appBinding = { ...sourceMeta.appBinding };
    }
    const token = createId();
    prepared.set(request.childConversationId, { request, token, files, meta });
    return { state: 'prepared', token };
  }
  async function commit(state, request) {
    const existing = await lookup(state, request);
    if (existing.state !== 'absent') return existing;
    const operation = prepared.get(request.childConversationId);
    if (!operation || operation.token !== request.token || !sameOrigin(operation.meta, request)) fail('preparation-unavailable');
    const childId = request.childConversationId;
    try {
      const receipt = operationReceipt(request);
      await assertPreparationIdentity(state, request);
      const reserved = await inspectPath(state.root, `conversation-branches/${receipt}`);
      // The empty entry's name is its complete identity; interruption cannot leave partial JSON.
      if (!reserved) await writeNew(state, `conversation-branches/${receipt}`, Buffer.alloc(0));
      await removeEntry(state, 'conversation-branches', childId);
      const checksums = await copyBranchFiles(operation.files);
      const prefix = `conversation-branches/${childId}`;
      const messages = operation.files.plan.messages;
      const ledger = messages.map((message, position) => serializeLedgerPut(childId, message, messages[position - 1]?.id,
        { findToolResultImageSnapshot: () => null })).join('');
      const projection = projectLedger({ ledgerText: ledger });
      if (projection.corruptCount || projection.messages.length !== messages.length) fail('invalid-history');
      for (const [relative, text] of [['messages.jsonl', ledger], ['outputs/manifest.json', JSON.stringify(operation.files.plan.manifest)]]) {
        const record = await writeNew(state, `${prefix}/${relative}`, Buffer.from(text));
        checksums.push({ ...record, relPath: relative });
      }
      const recovery = { version: 1, sourceConversationId: request.sourceConversationId, targetMessageId: request.targetMessageId,
        childConversationId: childId, meta: operation.meta, messageCount: messages.length, files: checksums };
      await writeNew(state, `${prefix}/${RECOVERY}`, Buffer.from(JSON.stringify(recovery)));
      await moveDirectory(state, childId);
      return await lookup(state, request);
    } finally { prepared.delete(childId); }
  }
  async function publish(state, request) {
    const result = await lookup(state, request);
    if (result.state === 'published') return result;
    if (result.state !== 'committed') fail('preparation-unavailable');
    const saved = (await index(state))[request.childConversationId];
    if (!isDeepStrictEqual(saved, result.meta)) fail('index-not-saved');
    await removeEntry(state, 'conversation-branches', operationReceipt(request));
    await removeEntry(state, `conversations/${request.childConversationId}`, RECOVERY);
    published.set(request.childConversationId, result.meta);
    return { state: 'published', meta: result.meta };
  }
  return async function dispatch(action, payload = {}) {
    if (action === 'cleanup') {
      z.object({}).strict().parse(payload);
      const state = await rootState();
      return serializeCommit(() => cleanStalePreparations(state));
    }
    if (action === 'pending') {
      z.object({}).strict().parse(payload);
      const state = await rootState();
      const stats = await inspectPath(state.root, 'conversations');
      if (!stats) return [];
      if (!stats.isDirectory()) fail('unsafe-directory');
      const entries = await fs.promises.readdir(path.join(state.root, 'conversations'), { withFileTypes: true });
      const pending = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!id.safeParse(entry.name).success) continue;
        // A damaged marker still hides this branch; recover reports its own failure.
        try {
          await fs.promises.lstat(path.join(state.root, 'conversations', entry.name, RECOVERY));
          pending.push(entry.name);
        } catch (error) {
          if (error.code !== 'ENOENT') pending.push(entry.name);
        }
      }
      return pending;
    }
    if (action === 'recover') {
      const { childConversationId } = z.object({ childConversationId: id }).strict().parse(payload);
      return serial(childConversationId, async () => {
        const state = await rootState();
        const recovery = await validateRecovery(state, childConversationId, await readText(state, `conversations/${childConversationId}/${RECOVERY}`));
        return { state: 'committed', meta: recovery.meta };
      });
    }
    const schema = action === 'prepare' ? prepareSchema : action === 'commit' ? identitySchema.extend({ token: z.string().min(1).max(128) }) : identitySchema;
    const request = schema.parse(payload);
    if (request.sourceConversationId.toLowerCase() === request.childConversationId.toLowerCase()) fail('invalid-child');
    return serial(request.childConversationId, async () => {
      const state = await rootState();
      if (action === 'lookup') return lookup(state, request);
      if (action === 'prepare') return prepare(state, request);
      if (action === 'publish') return publish(state, request);
      if (action === 'commit') {
        return serializeCommit(() => commit(state, request));
      }
      if (action === 'discard') { prepared.delete(request.childConversationId); return null; }
      fail('invalid-action');
    });
  };
}

module.exports = { CHANNEL, RECOVERY, createConversationBranchHost };
