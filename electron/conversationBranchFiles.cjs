'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { identityOf, sameIdentity } = require('./fileIdentity.cjs');
const { bytesMatchMediaType } = require('./mediaSignature.cjs');
const { createNativeFileSession } = require('./nativeHelperManager.cjs');
const {
  assertConversationId, assertBranchRelativePath, buildConversationBranchFilePlan,
  markBranchFilesMissing, readOutputManifestRecords,
} = require('./generated/conversationBranch.cjs');

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_CONVERSATION_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

function fail(code) {
  const error = new Error(`Conversation branch files: ${code}`);
  error.code = code;
  throw error;
}

async function optionalStat(filename) {
  try {
    return await fs.promises.lstat(filename, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function pin(stats) {
  return {
    identity: identityOf(stats), size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(), ctimeNs: stats.ctimeNs.toString(),
  };
}

function matches(stats, expected) {
  return sameIdentity(identityOf(stats), expected.identity)
    && stats.size.toString() === expected.size
    && stats.mtimeNs.toString() === expected.mtimeNs
    && stats.ctimeNs.toString() === expected.ctimeNs;
}

function assertRegular(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || !identityOf(stats)?.ino) fail('unsafe-file');
}

/** Every component is checked; a missing ancestor is an originally missing file. */
async function inspectPath(root, relative) {
  assertBranchRelativePath(relative);
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stats = await optionalStat(current);
    if (!stats) return null;
    if (stats.isSymbolicLink()) fail('unsafe-file');
    if (index < parts.length - 1 && !stats.isDirectory()) fail('unsafe-directory');
    if (index === parts.length - 1) return stats;
  }
  fail('invalid-path');
}

async function assertRoot(root, identity) {
  const stats = await fs.promises.lstat(root, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(identityOf(stats), identity)) fail('source-changed');
  if (await fs.promises.realpath(root) !== root) fail('unsafe-directory');
}

async function readPinnedFile(root, rootIdentity, relative, expected, limit, onChunk) {
  await assertRoot(root, rootIdentity);
  const before = await inspectPath(root, relative);
  if (!before) {
    if (expected) fail('source-changed');
    return null;
  }
  assertRegular(before);
  if (before.size > BigInt(limit)) fail('file-too-large');
  if (expected && !matches(before, expected)) fail('source-changed');
  const filename = path.join(root, relative);
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegular(opened);
    const initial = pin(before);
    if (!matches(opened, expected ?? initial)) fail('source-changed');
    const resolved = await fs.promises.realpath(filename);
    if (resolved !== filename) fail('unsafe-file');
    const observed = await inspectPath(root, relative);
    if (!observed || !matches(observed, initial)) fail('source-changed');
    await assertRoot(root, rootIdentity);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let offset = 0;
    while (offset < Number(opened.size)) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, Number(opened.size) - offset), offset);
      if (bytesRead === 0) fail('source-changed');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (onChunk) await onChunk(chunk);
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await inspectPath(root, relative);
    if (!matches(after, initial) || !named || !matches(named, initial)) fail('source-changed');
    await assertRoot(root, rootIdentity);
    const sha256 = hash.digest('hex');
    if (expected && sha256 !== expected.sha256) fail('source-changed');
    return { ...initial, sha256 };
  } finally {
    await handle.close();
  }
}

async function readOptionalText(root, rootIdentity, relative) {
  const chunks = [];
  const result = await readPinnedFile(root, rootIdentity, relative, null, MAX_MANIFEST_BYTES, chunk => {
    chunks.push(Buffer.from(chunk));
  });
  return result ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) : null;
}

function assertEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.originalPath !== 'string' || typeof entry.basename !== 'string'
    || typeof entry.snapshotRelPath !== 'string' || typeof entry.refId !== 'string'
    || typeof entry.refKind !== 'string' || !['tool-output', 'user-upload', 'code-save'].includes(entry.source)
    || !Number.isSafeInteger(entry.size) || entry.size < 0
    || !Number.isFinite(entry.originalMtime) || !Number.isFinite(entry.snapshottedAt)
    || (entry.captureId !== undefined && typeof entry.captureId !== 'string')
    || (entry.missing !== undefined && entry.missing !== true)) fail('invalid-manifest');
  if (entry.snapshotRelPath) assertBranchRelativePath(entry.snapshotRelPath);
}

async function readManifestHistory(root, rootIdentity, sourceId) {
  const prefix = `conversations/${sourceId}/outputs`;
  const entries = [];
  const baseText = await readOptionalText(root, rootIdentity, `${prefix}/manifest.json`);
  if (baseText !== null) {
    const base = JSON.parse(baseText);
    if (base.version !== 1 || !base.entries || typeof base.entries !== 'object' || Array.isArray(base.entries)) fail('invalid-manifest');
    for (const [key, entry] of Object.entries(base.entries)) {
      assertEntry(entry);
      if (key !== entry.originalPath) fail('invalid-manifest');
      entries.push(entry);
    }
  }
  const logText = await readOptionalText(root, rootIdentity, `${prefix}/manifest-log.jsonl`);
  for (const record of logText === null ? [] : readOutputManifestRecords(logText)) {
    if (record.op === 'set') {
      assertEntry(record.entry);
      entries.push(record.entry);
    } else {
      for (const entry of entries) {
        if (entry.originalPath === record.originalPath && entry.snapshottedAt === record.snapshottedAt
          && (record.captureId === undefined || entry.captureId === record.captureId)) entry.missing = true;
      }
    }
  }
  return entries;
}

function referencedManifestState(entries, files) {
  const paths = new Set(files.filter(file => file.sourceRelPath.startsWith('outputs/')).map(file => file.sourceRelPath.slice('outputs/'.length)));
  return JSON.stringify(entries.filter(entry => paths.has(entry.snapshotRelPath)));
}

function decodeInline(inline) {
  if (typeof inline.data !== 'string' || inline.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) fail('file-too-large');
  const bytes = Buffer.from(inline.data, 'base64');
  if (bytes.toString('base64') !== inline.data || !bytesMatchMediaType(bytes, inline.mediaType)) fail('invalid-attachment');
  return bytes;
}

async function assertCopyCapacity(root, rootIdentity, additionalBytes) {
  await assertRoot(root, rootIdentity);
  let total = BigInt(additionalBytes);
  async function count(relative, outputRoot = false) {
    const stats = await inspectPath(root, relative);
    if (!stats) return;
    if (stats.isDirectory()) {
      for (const name of await fs.promises.readdir(path.join(root, relative))) {
        if (outputRoot && (name === 'manifest.json' || name === 'manifest-log.jsonl')) continue;
        await count(`${relative}/${name}`);
      }
    } else {
      assertRegular(stats);
      total += stats.size;
      if (total > BigInt(MAX_TOTAL_BYTES)) fail('storage-limit');
    }
  }
  for (const base of ['conversations', 'conversation-branches']) {
    const stats = await inspectPath(root, base);
    if (!stats) continue;
    if (!stats.isDirectory()) fail('unsafe-directory');
    for (const name of await fs.promises.readdir(path.join(root, base))) {
      const entry = await inspectPath(root, `${base}/${name}`);
      if (entry?.isDirectory()) {
        await count(`${base}/${name}/outputs`, true);
        await count(`${base}/${name}/results`);
      }
    }
  }
  await assertRoot(root, rootIdentity);
}

/** Called only with host-derived appData and ledger messages, never renderer paths. */
async function prepareBranchFiles({ appDataDir, sourceConversationId, childConversationId, messages, messageIdMap }) {
  assertConversationId(sourceConversationId);
  assertConversationId(childConversationId);
  if (sourceConversationId.toLowerCase() === childConversationId.toLowerCase()) fail('invalid-child');
  const root = await fs.promises.realpath(appDataDir);
  const rootIdentity = identityOf(await fs.promises.lstat(root, { bigint: true }));
  await assertRoot(root, rootIdentity);
  const sourceDirectory = path.join(root, 'conversations', sourceConversationId);
  const sourceStats = await inspectPath(root, `conversations/${sourceConversationId}`);
  if (!sourceStats?.isDirectory()) fail('source-unavailable');
  const entries = await readManifestHistory(root, rootIdentity, sourceConversationId);
  const plan = buildConversationBranchFilePlan({
    sourceConversationId, childConversationId, sourceDirectory,
    childDirectory: path.join(root, 'conversations', childConversationId), messages, messageIdMap, entries,
  });
  const records = [];
  const missing = new Set();
  let totalBytes = 0;
  // Inline PDFs remain in the independent child ledger.
  for (const message of plan.messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'document' && block.source.data) {
        totalBytes += decodeInline({ data: block.source.data, mediaType: block.source.media_type }).length;
      }
    }
  }
  for (const file of plan.files) {
    if (file.missing) {
      missing.add(file.targetRelPath);
      continue;
    }
    if (file.inline) {
      const bytes = decodeInline(file.inline);
      records.push({ targetRelPath: file.targetRelPath, inline: file.inline, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      totalBytes += bytes.length;
    } else {
      let relative = `conversations/${sourceConversationId}/${file.sourceRelPath}`;
      let frozen = await readPinnedFile(root, rootIdentity, relative, null, MAX_FILE_BYTES);
      if (!frozen && file.sourceArea === 'legacy') {
        relative = `sessions/${sourceConversationId}/${file.sourceRelPath}`;
        frozen = await readPinnedFile(root, rootIdentity, relative, null, MAX_FILE_BYTES);
      }
      if (!frozen) {
        missing.add(file.targetRelPath);
        continue;
      }
      records.push({ sourceRelative: relative, targetRelPath: file.targetRelPath, frozen, size: Number(frozen.size), sha256: frozen.sha256 });
      totalBytes += Number(frozen.size);
    }
    if (totalBytes > MAX_CONVERSATION_BYTES) fail('conversation-too-large');
  }
  if (totalBytes > MAX_CONVERSATION_BYTES) fail('conversation-too-large');
  const currentEntries = await readManifestHistory(root, rootIdentity, sourceConversationId);
  if (referencedManifestState(entries, plan.files) !== referencedManifestState(currentEntries, plan.files)) fail('source-changed');
  for (const entry of Object.values(plan.manifest.entries)) {
    const record = records.find(value => value.targetRelPath === `outputs/${entry.snapshotRelPath}`);
    if (record) entry.size = record.size;
  }
  markBranchFilesMissing(plan, path.join(root, 'conversations', childConversationId), missing);
  await assertCopyCapacity(root, rootIdentity, records.reduce((sum, record) => sum + record.size, 0));
  return { root, rootIdentity, sourceConversationId, childConversationId, plan, records, totalBytes };
}

/** Writes into the unpublished child directory; the transaction owns cleanup and rename. */
async function copyBranchFiles(prepared) {
  const { root, rootIdentity, childConversationId, records } = prepared;
  assertConversationId(childConversationId);
  const prefix = `conversation-branches/${childConversationId}`;
  await assertCopyCapacity(root, rootIdentity, records.reduce((sum, record) => sum + record.size, 0));
  const checksums = [];
  for (const record of records) {
    assertBranchRelativePath(record.targetRelPath);
    const relative = `${prefix}/${record.targetRelPath}`;
    const filename = path.join(root, relative);
    const target = { path: filename, purpose: 'write', followFinalSymlink: false };
    const source = record.inline ? null
      : { path: path.join(root, record.sourceRelative), purpose: 'read', followFinalSymlink: false };
    if (source) await readPinnedFile(root, rootIdentity, record.sourceRelative, record.frozen, MAX_FILE_BYTES);
    const session = createNativeFileSession(source ? [source, target] : [target]);
    try {
      if (await inspectPath(root, relative)) fail('destination-exists');
      const observed = await session.request('observe', target);
      if (observed.exists || path.resolve(observed.canonicalPath) !== filename) fail('unsafe-directory');
      await assertRoot(root, rootIdentity);
      let offset = 0;
      const write = async bytes => {
        for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
          const chunk = bytes.subarray(start, start + CHUNK_BYTES);
          const result = await session.request('write-chunk', { reference: observed.reference, offset, bytes: [...chunk] });
          offset += chunk.length;
          if (result.written !== offset) fail('write-failed');
        }
      };
      if (record.inline) {
        const bytes = decodeInline(record.inline);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== record.sha256) fail('source-changed');
        await write(bytes);
      } else {
        const input = await session.request('observe', source);
        if (!input.isFile || input.isSymlink || path.resolve(input.canonicalPath) !== source.path) fail('unsafe-file');
        const result = await session.request('copy-file', { reference: observed.reference, sourceReference: input.reference, size: record.size });
        if (result.written !== record.size) fail('copy-mismatch');
        await readPinnedFile(root, rootIdentity, record.sourceRelative, record.frozen, MAX_FILE_BYTES);
      }
      if (record.inline) {
        if (offset === 0) await session.request('write-chunk', { reference: observed.reference, offset: 0, bytes: [] });
        await session.request('finish-write', { reference: observed.reference, size: offset });
      }
    } finally {
      await session.release();
    }
    const checked = await readPinnedFile(root, rootIdentity, relative, null, MAX_FILE_BYTES);
    if (!checked || checked.sha256 !== record.sha256 || Number(checked.size) !== record.size) fail('copy-mismatch');
    checksums.push({ relPath: record.targetRelPath, size: record.size, sha256: record.sha256 });
  }
  await assertCopyCapacity(root, rootIdentity, 0);
  return checksums;
}

module.exports = {
  prepareBranchFiles, copyBranchFiles, readPinnedFile, readManifestHistory,
  inspectPath, assertRoot, MAX_FILE_BYTES, MAX_CONVERSATION_BYTES, MAX_TOTAL_BYTES,
};
