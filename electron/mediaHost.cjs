'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { projectLedger } = require('./generated/ledgerReader.cjs');
const { createConversationPaths, collectPresentedFiles, mediaFileRefSchema, mediaMimeType, foldLog } = require('./generated/mediaRuntime.cjs');
const { createMediaProtocol } = require('./mediaProtocol.cjs');
const { createMediaCaptureStore, readControlledImage } = require('./mediaCaptureStore.cjs');
const { createImageEditHost } = require('./imageEditHost.cjs');
const { assertAllowed } = require('./fsHost.cjs');
const { writeImageAtomically } = require('./imageSaveHost.cjs');
const { wireRendererResourceCleanup } = require('./rendererLifecycle.cjs');
const { createMediaStorageBudget } = require('./mediaStorageBudget.cjs');

const MEDIA_CHANNEL = 'abu:media';

function readText(filePath) {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(descriptor, 'utf8'); } finally { fs.closeSync(descriptor); }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function createMediaHost({ dataRoot, getConversation, onChange, assertCapacity = createMediaStorageBudget(dataRoot) }) {
  const paths = createConversationPaths(dataRoot);
  const deleted = new Set();
  const owners = new WeakMap();
  const activeOwners = new Set();
  const preparations = new Map();

  function sourceInUse(captureId) {
    return [...activeOwners].some(owner => owner.captures.has(captureId))
      || [...preparations.values()].some(item => item.fileRef.captureId === captureId);
  }

  function captureOwner(sender) {
    let owner = owners.get(sender);
    if (owner) return owner;
    owner = { generation: 0, captures: new Map(), requests: new Map() };
    owners.set(sender, owner);
    activeOwners.add(owner);
    const clear = () => {
      owner.generation += 1;
      const previous = [...owner.captures.values()];
      owner.captures.clear();
      for (const { conversationId, fileRef } of previous) {
        if (!sourceInUse(fileRef.captureId) && !deleted.has(conversationId) && getConversation(conversationId)) captures.release(conversationId, fileRef);
      }
      for (const { conversationId, requestId } of owner.requests.values()) {
        if (!deleted.has(conversationId) && getConversation(conversationId)) discardPrepared(conversationId, requestId);
      }
      owner.requests.clear();
    };
    const removeNavigation = wireRendererResourceCleanup(sender, clear);
    sender.on('render-process-gone', clear);
    sender.once('destroyed', () => { clear(); activeOwners.delete(owner); removeNavigation(); sender.removeListener('render-process-gone', clear); });
    return owner;
  }

  function assertConversation(conversationId) {
    const directory = paths.conversationDir(conversationId);
    const row = getConversation(conversationId);
    if (!row || row.missing || deleted.has(conversationId)) throw new Error('Media conversation is unavailable');
    if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('Media conversation directory changed');
  }

  function messages(conversationId) {
    assertConversation(conversationId);
    const ledger = paths.messagesPath(conversationId);
    const snapshot = paths.streamSnapshotPath(conversationId);
    return projectLedger({
      ledgerText: fs.existsSync(ledger) ? readText(ledger) : '',
      snapshotText: fs.existsSync(snapshot) ? readText(snapshot) : undefined,
    }).messages;
  }

  function resolveFile(conversationId, input) {
    const reference = mediaFileRefSchema.parse(input);
    if (!path.isAbsolute(reference.originalPath)) throw new Error('Media file requires an absolute path');
    const ownedMessages = messages(conversationId);
    const inherited = ownedMessages.filter(message => message.inheritedFromBranch).flatMap(message => [
      ...(message.imageEditRequest?.attachmentRefs ?? []).map(attachment => attachment.fileRef),
      ...(message.mediaArtifacts ?? []).map(artifact => artifact.fileRef),
    ]).find(fileRef => isDeepStrictEqual(fileRef, reference)
      || (!reference.captureId && !reference.contentDigest && fileRef.originalPath === reference.originalPath));
    if (inherited) {
      const outputs = paths.outputsDir(conversationId);
      if (!inside(outputs, reference.originalPath) || fs.realpathSync(outputs) !== path.resolve(outputs)) {
        throw new Error('Inherited media is outside its conversation');
      }
      const manifest = JSON.parse(readText(path.join(outputs, 'manifest.json')));
      if (manifest.version !== 1 || !manifest.entries || typeof manifest.entries !== 'object') throw new Error('Image history is unavailable');
      const entry = Object.values(manifest.entries).find(item => item.inheritedFromBranch
        && path.resolve(outputs, item.snapshotRelPath) === path.resolve(reference.originalPath));
      if (!entry || entry.missing) throw new Error('Inherited media is unavailable');
      if (!inside(outputs, fs.realpathSync(reference.originalPath))) throw new Error('Inherited media is outside its conversation');
      const mimeType = mediaMimeType(reference.originalPath);
      if (!mimeType) throw new Error('Unsupported media file');
      return { path: reference.originalPath, mimeType, contentDigest: inherited.contentDigest, allowedRoot: outputs };
    }
    if (reference.captureId) return captures.get(conversationId, reference);
    const artifact = ownedMessages.flatMap(message => message.mediaArtifacts ?? [])
      .find(item => isDeepStrictEqual(item.fileRef, reference)
        || (!reference.contentDigest && path.resolve(item.fileRef.originalPath) === path.resolve(reference.originalPath)));
    const delivered = !reference.captureId && !reference.contentDigest && ownedMessages.some(message =>
      collectPresentedFiles(message.toolCalls ?? []).some(file => path.resolve(file.path) === path.resolve(reference.originalPath))
      || (Array.isArray(message.content) && message.content.some(file => file.filePath === reference.originalPath)));
    const mimeType = mediaMimeType(reference.originalPath);
    if (!mimeType) throw new Error('Unsupported media file');
    if (artifact || (delivered && fs.existsSync(reference.originalPath))) {
      return { path: reference.originalPath, mimeType, contentDigest: artifact?.fileRef.contentDigest };
    }
    if (reference.contentDigest) throw new Error('Media file does not belong to this conversation');
    const outputs = paths.outputsDir(conversationId);
    if (fs.existsSync(outputs)) {
      if (fs.realpathSync(outputs) !== path.resolve(outputs)) throw new Error('Media output directory changed');
      const legacyPath = path.join(outputs, 'manifest.json');
      const manifest = fs.existsSync(legacyPath) ? JSON.parse(readText(legacyPath)) : { version: 1, entries: {} };
      if (manifest.version !== 1 || !manifest.entries || typeof manifest.entries !== 'object') throw new Error('Image history is unavailable');
      const logPath = path.join(outputs, 'manifest-log.jsonl');
      if (fs.existsSync(logPath)) foldLog(conversationId, readText(logPath), manifest.entries);
      const entry = Object.values(manifest.entries).find(item => item.snapshotRelPath &&
        (item.originalPath === reference.originalPath || path.resolve(outputs, item.snapshotRelPath) === path.resolve(reference.originalPath)));
      if (entry) {
        const copy = path.resolve(outputs, entry.snapshotRelPath);
        if (!inside(outputs, copy) || !inside(outputs, fs.realpathSync(copy))) throw new Error('Media copy is outside its conversation');
        const imported = entry.refId === 'shared-import' && entry.refKind === 'shared';
        if (!imported && path.isAbsolute(entry.originalPath)) assertAllowed(entry.originalPath, { followFinalSymlink: false });
        return { path: copy, originalPath: !imported && path.isAbsolute(entry.originalPath) ? entry.originalPath : copy, mimeType, allowedRoot: outputs };
      }
      if (inside(outputs, reference.originalPath) && inside(outputs, fs.realpathSync(reference.originalPath))) {
        return { path: reference.originalPath, mimeType, allowedRoot: outputs };
      }
    }
    const indexPath = paths.indexFilePath();
    const index = fs.existsSync(indexPath) ? JSON.parse(readText(indexPath)) : undefined;
    const workspace = index?.version === 1 ? index.entries?.[conversationId]?.workspacePath : undefined;
    if (typeof workspace === 'string' && path.isAbsolute(workspace)
      && inside(workspace, reference.originalPath) && inside(fs.realpathSync(workspace), fs.realpathSync(reference.originalPath))) {
      assertAllowed(reference.originalPath, { followFinalSymlink: true });
      return { path: reference.originalPath, mimeType, allowedRoot: fs.realpathSync(workspace) };
    }
    throw new Error('Media file does not belong to this conversation');
  }

  const protocol = createMediaProtocol({ resolveFile, assertConversation });
  const captures = createMediaCaptureStore({ root: path.join(dataRoot, 'media', 'captures'), assertConversation, assertCapacity });
  const scope = `local:${createHash('sha256').update(dataRoot).digest('hex')}`;
  const edits = createImageEditHost({ root: path.join(dataRoot, 'media'), scope, captures, assertConversation, assertCapacity, onChange });

  function hasMessage(request) {
    return messages(request.conversationId).some(message => message.id === request.messageId && message.role === 'user' && !message.inheritedFromBranch
      && isDeepStrictEqual(message.imageEditRequest, request));
  }

  function discardPrepared(conversationId, requestId) {
    const record = edits.jobs.find(conversationId, requestId);
    if (!record || record.job.generationState !== 'prepared' || hasMessage(record.request)) return [];
    edits.discardPrepared(conversationId, requestId);
    const retained = new Set(edits.jobs.list().flatMap(item => item.request.attachmentRefs.map(attachment => attachment.fileRef.captureId)));
    const released = [];
    for (const attachment of record.request.attachmentRefs) {
      const reference = attachment.fileRef;
      if (retained.has(reference.captureId)) continue;
      captures.unretain(conversationId, reference);
      if (!sourceInUse(reference.captureId)) {
        captures.release(conversationId, reference);
        released.push(reference.captureId);
      }
    }
    for (const owner of activeOwners) owner.requests.delete(`${conversationId}\0${requestId}`);
    return released;
  }

  const saved = edits.jobs.list();
  const inaccessible = new Set();
  for (const record of saved) {
    const conversationId = record.request.conversationId;
    const row = getConversation(conversationId);
    let directoryExists = false;
    try {
      fs.lstatSync(paths.conversationDir(conversationId));
      directoryExists = true;
    } catch (error) {
      if (['EACCES', 'EPERM'].includes(error.code)) {
        inaccessible.add(conversationId);
        continue;
      }
      if (error.code !== 'ENOENT') throw error;
    }
    if (!row && directoryExists) {
      inaccessible.add(conversationId);
      continue;
    }
    if (!row || row.missing || !directoryExists) {
      deleted.add(conversationId);
      edits.forget(conversationId);
      captures.forget(conversationId);
      continue;
    }
    if (record.job.generationState === 'prepared') {
      let recorded;
      try {
        recorded = hasMessage(record.request);
      } catch (error) {
        if (!['EACCES', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
        inaccessible.add(conversationId);
        continue;
      }
      if (!recorded) edits.discardPrepared(record.request.conversationId, record.request.id);
    }
  }
  captures.reconcile(edits.jobs.list().filter(record => !inaccessible.has(record.request.conversationId)), inaccessible);
  return {
    protocol,
    scope,
    assertConversation,
    messages,
    resolveFile,
    forget(conversationId) {
      paths.conversationDir(conversationId);
      deleted.add(conversationId);
      protocol.revokeConversation(conversationId);
      edits.forget(conversationId);
      captures.forget(conversationId);
    },
    async dispatch(sender, action, request) {
      if (action === 'open') return protocol.grant(sender, request.conversationId, request.fileRef);
      if (action === 'release') return protocol.release(sender, request.token);
      if (action === 'renew') return protocol.renew(sender, request.token);
      if (action === 'release-capture') {
        if (deleted.has(request.conversationId) || !getConversation(request.conversationId)) return;
        owners.get(sender)?.captures.delete(request.fileRef.captureId);
        if (sourceInUse(request.fileRef.captureId)) return;
        return captures.release(request.conversationId, mediaFileRefSchema.parse(request.fileRef));
      }
      if (action === 'prepare-edit') {
        const owner = captureOwner(sender);
        const generation = owner.generation;
        const preparation = Symbol();
        const { conversationId, source } = request.draft;
        const fileRef = mediaFileRefSchema.parse(source.fileRef);
        preparations.set(preparation, { conversationId, fileRef });
        try {
          const record = await edits.prepare(request.draft, request.backend);
          if (sender.isDestroyed() || generation !== owner.generation) {
            discardPrepared(record.request.conversationId, record.request.id);
            throw new Error('Image editing window is unavailable');
          }
          owner.requests.set(`${record.request.conversationId}\0${record.request.id}`, { conversationId: record.request.conversationId, requestId: record.request.id });
          return record;
        } finally {
          preparations.delete(preparation);
          if (!sourceInUse(fileRef.captureId) && !deleted.has(conversationId) && getConversation(conversationId)) captures.release(conversationId, fileRef);
        }
      }
      if (action === 'discard-prepared-edit') return discardPrepared(request.conversationId, request.requestId);
      if (action === 'get-edit') return edits.jobs.get(request.conversationId, request.requestId);
      if (action === 'detach-edit') return edits.jobs.detach(request.conversationId, request.requestId);
      if (action === 'retry-save') return edits.retrySave(request.conversationId, request.requestId);
      if (action === 'execute-edit') {
        if (messages(request.conversationId).some(message => message.inheritedFromBranch && message.imageEditRequest?.id === request.requestId)) {
          throw new Error('Inherited image edits are historical records');
        }
        const record = edits.jobs.get(request.conversationId, request.requestId);
        const userMessage = messages(request.conversationId).find(message => message.id === record.request.messageId && message.role === 'user');
        if (!userMessage || !isDeepStrictEqual(userMessage.imageEditRequest, record.request)) throw new Error('Image request is not present in this conversation');
        return edits.execute(request.conversationId, request.requestId);
      }
      if (action === 'capture') {
        const owner = captureOwner(sender);
        const generation = owner.generation;
        const file = resolveFile(request.conversationId, request.fileRef);
        if (!file.mimeType.startsWith('image/')) throw new Error('Image editing requires an image');
        if (request.fileRef.captureId && file.attachment?.kind === 'source') {
          const preparation = Symbol();
          preparations.set(preparation, { conversationId: request.conversationId, fileRef: request.fileRef });
          try {
            await captures.read(request.conversationId, request.fileRef);
            if (sender.isDestroyed() || owner.generation !== generation) throw new Error('Image editing window is unavailable');
            owner.captures.set(request.fileRef.captureId, { conversationId: request.conversationId, fileRef: request.fileRef });
            return file.attachment;
          } finally {
            preparations.delete(preparation);
            if (!sourceInUse(request.fileRef.captureId) && !deleted.has(request.conversationId) && getConversation(request.conversationId)) captures.release(request.conversationId, request.fileRef);
          }
        }
        const attachment = await captures.capture(request.conversationId, file);
        if (sender.isDestroyed() || owner.generation !== generation) {
          captures.release(request.conversationId, attachment.fileRef);
          throw new Error('Image editing window is unavailable');
        }
        owner.captures.set(attachment.fileRef.captureId, { conversationId: request.conversationId, fileRef: attachment.fileRef });
        return attachment;
      }
      if (action === 'save-image') {
        const file = resolveFile(request.conversationId, request.fileRef);
        if (!file.mimeType.startsWith('image/')) throw new Error('Image saving requires an image');
        const bytes = await readControlledImage(file.path, file.allowedRoot);
        if (file.contentDigest && createHash('sha256').update(bytes).digest('hex') !== file.contentDigest) throw new Error('Image content changed');
        assertConversation(request.conversationId);
        const destination = assertAllowed(request.destinationPath, { followFinalSymlink: false });
        writeImageAtomically(destination, bytes);
        return;
      }
      if (action === 'forget') return this.forget(request.conversationId);
      throw new Error('Unsupported media operation');
    },
  };
}

module.exports = { MEDIA_CHANNEL, createMediaHost };
