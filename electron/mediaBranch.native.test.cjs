'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const { createConversationBranchHost } = require('./conversationBranchHost.cjs');
const { createMediaCaptureStore } = require('./mediaCaptureStore.cjs');
const { createMediaHost } = require('./mediaHost.cjs');
const { createMediaStorageBudget } = require('./mediaStorageBudget.cjs');
const { conversationBranchPrefix, projectLedger, serializeLedgerPut } = require('./generated/conversationBranch.cjs');
const { killNativeHelper } = require('./nativeHelperManager.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
test.after(() => killNativeHelper('media-branch-tests-finished'));

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.agent/media-branch');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  const cleanup = [];
  t.after(() => {
    for (const dispose of cleanup) dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'conversations/source'), { recursive: true });
  const bytes = await sharp({ create: { width: 80, height: 60, channels: 4, background: '#aabbcc' } }).png().toBuffer();
  const captures = createMediaCaptureStore({ root: path.join(root, 'media/captures'), assertConversation: id => {
    assert.ok(fs.statSync(path.join(root, 'conversations', id)).isDirectory());
  } });
  const source = captures.store('source', path.join(root, 'original.png'), 'source', bytes, 80, 60);
  const mask = captures.store('source', source.fileRef.originalPath, 'mask', bytes, 80, 60);
  const reference = captures.store('source', source.fileRef.originalPath, 'reference', bytes, 80, 60);
  const request = {
    schemaVersion: 1, id: 'request', scope: 'local', conversationId: 'source', messageId: 'user',
    sourceArtifactId: 'original', sourceCaptureId: source.fileRef.captureId, sourceDigest: source.fileRef.contentDigest,
    prompt: 'Make the background green', comments: [{ id: 'comment', point: { x: 0.5, y: 0.5 }, text: 'Keep this' }],
    markup: [], region: [], attachmentRefs: [source, mask, reference], backendId: 'images', capabilityVersion: '1',
  };
  const resultPath = path.join(root, 'media/results', hash('source'), hash('request'), 'image.png');
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, bytes);
  const artifact = {
    schemaVersion: 1, id: 'result', conversationId: 'source', messageId: 'answer', kind: 'image', mimeType: 'image/png',
    fileRef: { originalPath: resultPath, contentDigest: hash(bytes) }, byteLength: bytes.length, width: 80, height: 60,
    groupId: 'request', order: 0, parentArtifactId: 'original', editRequestId: 'request',
  };
  const messages = [
    { id: 'user', role: 'user', content: request.prompt, timestamp: 1, runState: 'completed', imageEditRequest: request },
    { id: 'answer', role: 'assistant', content: '', timestamp: 2, mediaArtifacts: [artifact] },
  ];
  const entries = { source: { id: 'source', title: 'Images', createdAt: 1, updatedAt: 2, messageCount: 2 } };
  const writeIndex = () => fs.writeFileSync(path.join(root, 'conversations/index.json'), JSON.stringify({ version: 1, entries }));
  writeIndex();
  fs.writeFileSync(path.join(root, 'conversations/source/messages.jsonl'), messages.map(message =>
    serializeLedgerPut('source', message, undefined, { findToolResultImageSnapshot: () => null })).join(''));
  const read = id => projectLedger({ ledgerText: fs.readFileSync(path.join(root, 'conversations', id, 'messages.jsonl'), 'utf8') }).messages;
  let sequence = 0;
  const host = () => createConversationBranchHost({ appDataDir: root, now: () => 10, createId: () => `branch-${++sequence}` });
  async function prepare(dispatch, sourceId, childId) {
    const history = read(sourceId);
    const identity = { sourceConversationId: sourceId, targetMessageId: history.at(-1).id, childConversationId: childId };
    const prepared = await dispatch('prepare', { ...identity,
      watermark: fs.statSync(path.join(root, 'conversations', sourceId, 'messages.jsonl')).size,
      prefix: conversationBranchPrefix(history, sourceId, identity.targetMessageId, () => null), title: 'Image branch', errorEmptyBody: '',
    });
    return { ...identity, token: prepared.token };
  }
  async function branch(sourceId, childId) {
    const dispatch = host();
    const input = await prepare(dispatch, sourceId, childId);
    const result = await dispatch('commit', input);
    entries[childId] = result.meta;
    writeIndex();
    const { token: _, ...identity } = input;
    await dispatch('publish', identity);
    return read(childId);
  }
  return { root, bytes, captures, source, request, artifact, entries, writeIndex, read, host, prepare, branch, cleanup };
}

test('branches every edit attachment, reopens without the parent, and captures a new child edit', async t => {
  const f = await fixture(t);
  const child = await f.branch('source', 'child');
  const childRequest = child[0].imageEditRequest;
  assert.equal(childRequest.conversationId, 'child');
  assert.equal(childRequest.messageId, child[0].id);
  assert.equal(child[1].mediaArtifacts[0].editRequestId, childRequest.id);
  const refs = [...childRequest.attachmentRefs.map(value => value.fileRef), child[1].mediaArtifacts[0].fileRef];
  for (const ref of refs) {
    assert.ok(ref.originalPath.startsWith(path.join(f.root, 'conversations/child/outputs/inherited')));
    assert.deepEqual(fs.readFileSync(ref.originalPath), f.bytes);
  }
  const host = createMediaHost({ dataRoot: f.root, getConversation: id => f.entries[id] });
  host.forget('source');
  fs.rmSync(path.join(f.root, 'conversations/source'), { recursive: true });
  delete f.entries.source;
  f.writeIndex();
  const reopened = createMediaHost({ dataRoot: f.root, getConversation: id => f.entries[id] });
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false });
  f.cleanup.push(() => sender.emit('destroyed'));
  for (const ref of refs) assert.equal(reopened.resolveFile('child', ref).path, ref.originalPath);
  await assert.rejects(reopened.dispatch(sender, 'execute-edit', { conversationId: 'child', requestId: childRequest.id }), /historical/);
  await assert.rejects(reopened.dispatch(sender, 'get-edit', { conversationId: 'child', requestId: childRequest.id }), /unavailable/);
  const fresh = await reopened.dispatch(sender, 'capture', { conversationId: 'child', fileRef: refs[0] });
  assert.notEqual(fresh.fileRef.captureId, refs[0].captureId);
  assert.deepEqual(fs.readFileSync(reopened.resolveFile('child', fresh.fileRef).path), f.bytes);
  const saved = path.join(f.root, 'saved.png');
  await reopened.dispatch(sender, 'save-image', { conversationId: 'child', fileRef: refs.at(-1), destinationPath: saved });
  assert.deepEqual(fs.readFileSync(saved), f.bytes);
  const grandchild = await f.branch('child', 'grandchild');
  assert.equal(grandchild[0].imageEditRequest.conversationId, 'grandchild');
  assert.notEqual(grandchild[0].imageEditRequest.id, childRequest.id);
  reopened.forget('child');
  fs.rmSync(path.join(f.root, 'conversations/child'), { recursive: true });
  delete f.entries.child;
  f.writeIndex();
  const finalHost = createMediaHost({ dataRoot: f.root, getConversation: id => f.entries[id] });
  for (const attachment of grandchild[0].imageEditRequest.attachmentRefs) {
    assert.deepEqual(fs.readFileSync(finalHost.resolveFile('grandchild', attachment.fileRef).path), f.bytes);
  }
});

test('refuses a capture whose saved metadata does not match the history', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'media/captures', hash('source'), `${f.source.fileRef.captureId}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...f.source, fileRef: { ...f.source.fileRef, originalPath: '/another.png' } }));
  await assert.rejects(f.prepare(f.host(), 'source', 'child'), /invalid-media-capture/);
});

test('branches fresh source, region and reference captures made from an inherited image', async t => {
  const f = await fixture(t);
  const child = await f.branch('source', 'child');
  const host = createMediaHost({ dataRoot: f.root, getConversation: id => f.entries[id] });
  const sender = Object.assign(new EventEmitter(), { id: 2, mainFrame: {}, isDestroyed: () => false });
  f.cleanup.push(() => sender.emit('destroyed'));
  const artifact = child[1].mediaArtifacts[0];
  const source = await host.dispatch(sender, 'capture', { conversationId: 'child', fileRef: artifact.fileRef });
  const record = await host.dispatch(sender, 'prepare-edit', { draft: {
    id: 'fresh-request', messageId: 'fresh-user', scope: host.scope, conversationId: 'child',
    sourceArtifactId: artifact.id, sourceCaptureId: source.fileRef.captureId, sourceDigest: source.fileRef.contentDigest,
    source, activeTool: 'region', prompt: 'Change the selected region', markup: [],
    comments: [{ id: 'comment', point: { x: 0.5, y: 0.5 }, text: 'Keep this' }],
    region: [{ id: 'region', erase: false, width: 0.2, points: [{ x: 0.2, y: 0.3 }, { x: 0.7, y: 0.6 }] }],
  }, backend: { id: 'images', vendor: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2.5-sunburst', apiKey: 'test-boundary-credential' } });
  const expected = record.request.attachmentRefs.map(attachment => ({
    kind: attachment.kind, bytes: fs.readFileSync(host.resolveFile('child', attachment.fileRef).path),
  }));
  assert.equal(new Set(expected.map(item => hash(item.bytes))).size, 3);
  const appended = [
    { id: 'fresh-user', role: 'user', content: record.request.prompt, timestamp: 3, runState: 'completed', imageEditRequest: record.request },
    { id: 'fresh-answer', role: 'assistant', content: 'Ready', timestamp: 4 },
  ];
  fs.appendFileSync(path.join(f.root, 'conversations/child/messages.jsonl'), appended.map(message =>
    serializeLedgerPut('child', message, undefined, { findToolResultImageSnapshot: () => null })).join(''));
  const grandchild = await f.branch('child', 'grandchild');
  const attachments = grandchild[2].imageEditRequest.attachmentRefs;
  for (const item of expected) {
    const attachment = attachments.find(value => value.kind === item.kind);
    assert.deepEqual(fs.readFileSync(attachment.fileRef.originalPath), item.bytes);
  }
});

test('refuses changed result bytes and cross-conversation result paths', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.artifact.fileRef.originalPath, Buffer.from('changed'));
  await assert.rejects(f.prepare(f.host(), 'source', 'child'), /media-content-changed/);
  const messages = f.read('source');
  messages[1].mediaArtifacts[0].fileRef.originalPath = path.join(f.root, 'media/results', hash('other'), hash('request'), 'image.png');
  fs.writeFileSync(path.join(f.root, 'conversations/source/messages.jsonl'), messages.map(value => JSON.stringify(value)).join('\n') + '\n');
  await assert.rejects(f.prepare(f.host(), 'source', 'child'), /invalid-media-result/);
});

test('refuses a source replacement after preparation and leaves no published child', async t => {
  const f = await fixture(t);
  const dispatch = f.host();
  const input = await f.prepare(dispatch, 'source', 'child');
  fs.writeFileSync(f.artifact.fileRef.originalPath, Buffer.from('changed'));
  await assert.rejects(dispatch('commit', input), /source-changed/);
  assert.equal(fs.existsSync(path.join(f.root, 'conversations/child')), false);
});

test('records missing media without borrowing bytes from a different conversation', async t => {
  const f = await fixture(t);
  fs.rmSync(f.artifact.fileRef.originalPath);
  const child = await f.branch('source', 'child');
  const host = createMediaHost({ dataRoot: f.root, getConversation: id => f.entries[id] });
  assert.throws(() => host.resolveFile('child', child[1].mediaArtifacts[0].fileRef), /unavailable/);
  assert.throws(() => host.resolveFile('source', child[1].mediaArtifacts[0].fileRef), /does not belong/);
});

test('shares capacity with pending image work and counts a reserved branch copy once', async t => {
  const f = await fixture(t);
  const budget = createMediaStorageBudget(f.root);
  const gib = 1024 ** 3;
  const reservations = ['one', 'two', 'three', 'four'].map(id => budget.reserve(id, gib));
  const branch = budget.reserve('child', gib - 65536, { branch: true });
  const staged = path.join(f.root, 'conversation-branches/child/outputs/inherited/image.png');
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, Buffer.alloc(0));
  fs.truncateSync(staged, gib - 65536);
  assert.doesNotThrow(() => budget('child', 0));
  assert.throws(() => budget.reserve('another', 131072), /capacity/);
  fs.renameSync(path.join(f.root, 'conversation-branches/child'), path.join(f.root, 'conversations/child'));
  assert.doesNotThrow(() => budget('child', 0));
  assert.doesNotThrow(() => budget.reserve('another', 1024).release());
  branch.release();
  assert.throws(() => budget.reserve('another', 131072), /capacity/);
  fs.rmSync(path.join(f.root, 'conversations/child'), { recursive: true });
  for (const reservation of reservations) reservation.release();
  assert.doesNotThrow(() => budget('source', 0));
});
