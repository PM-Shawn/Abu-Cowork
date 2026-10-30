'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const { createMediaHost } = require('./mediaHost.cjs');
const { killNativeHelper } = require('./nativeHelperManager.cjs');
const { createHash } = require('node:crypto');

test.after(() => killNativeHelper('media-host-tests-finished'));

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.agent/media-host');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  const conversationId = 'conversation-1';
  const outputs = path.join(root, 'conversations', conversationId, 'outputs');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(outputs, { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(root, 'conversations', 'index.json'), JSON.stringify({ version: 1, entries: { [conversationId]: { workspacePath: workspace } } }));
  const filePath = path.join(workspace, 'source.png');
  await sharp({ create: { width: 80, height: 60, channels: 3, background: '#aabbcc' } }).png().toFile(filePath);
  const host = createMediaHost({ dataRoot: root, getConversation: id => id === conversationId ? { missing: false } : null });
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false });
  t.after(() => { sender.emit('destroyed'); host.forget(conversationId); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, host, conversationId, outputs, workspace, filePath, sender };
}

test('workspace images use real captures and navigation releases unused drafts', async t => {
  const f = await fixture(t);
  const source = await f.host.dispatch(f.sender, 'capture', { conversationId: f.conversationId, fileRef: { originalPath: f.filePath } });
  const captured = f.host.resolveFile(f.conversationId, source.fileRef).path;
  assert.equal((await sharp(captured).metadata()).width, 80);
  f.sender.emit('did-start-navigation', {}, 'file:///next.html', false, true);
  assert.equal(fs.existsSync(captured), false);
});

async function prepareEdit(f, id, source) {
  source ??= await f.host.dispatch(f.sender, 'capture', { conversationId: f.conversationId, fileRef: { originalPath: f.filePath } });
  return f.host.dispatch(f.sender, 'prepare-edit', {
    draft: {
      id, messageId: `message-${id}`, scope: f.host.scope, conversationId: f.conversationId,
      sourceArtifactId: 'source-1', sourceCaptureId: source.fileRef.captureId, sourceDigest: source.fileRef.contentDigest,
      source, activeTool: 'prompt', prompt: 'Make it green', comments: [], markup: [], region: [],
    },
    backend: { id: 'images', vendor: 'volcengine', model: 'doubao-seedream-5.0-flash', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations', apiKey: 'test-boundary-credential' },
  });
}

function persistRequest(f, record) {
  fs.writeFileSync(path.join(f.root, 'conversations', f.conversationId, 'messages.jsonl'), JSON.stringify({
    id: record.request.messageId, role: 'user', content: record.request.prompt, timestamp: 1, imageEditRequest: record.request,
  }) + '\n');
}

test('closing a window releases prepared requests which have no conversation message', async t => {
  const f = await fixture(t);
  const record = await prepareEdit(f, 'edit-1');
  const reference = record.request.attachmentRefs[0].fileRef;
  const captured = f.host.resolveFile(f.conversationId, reference).path;
  f.sender.emit('render-process-gone');
  assert.equal(fs.existsSync(captured), false);
  await assert.rejects(f.host.dispatch(f.sender, 'get-edit', { conversationId: f.conversationId, requestId: record.request.id }), /unavailable/);
});

test('cancelled queued requests preserve a shared source until its last request is removed', async t => {
  const f = await fixture(t);
  const first = await prepareEdit(f, 'edit-1');
  const source = first.request.attachmentRefs[0];
  const second = await prepareEdit(f, 'edit-2', source);
  const captured = f.host.resolveFile(f.conversationId, source.fileRef).path;
  await f.host.dispatch(f.sender, 'release-capture', { conversationId: f.conversationId, fileRef: source.fileRef });
  assert.deepEqual(await f.host.dispatch(f.sender, 'discard-prepared-edit', { conversationId: f.conversationId, requestId: first.request.id }), []);
  assert.ok(fs.existsSync(captured));
  assert.deepEqual(await f.host.dispatch(f.sender, 'discard-prepared-edit', { conversationId: f.conversationId, requestId: second.request.id }), [source.fileRef.captureId]);
  assert.equal(fs.existsSync(captured), false);
});

test('a rejected send preserves the source while its draft is still active', async t => {
  const f = await fixture(t);
  const record = await prepareEdit(f, 'edit-1');
  const reference = record.request.attachmentRefs[0].fileRef;
  const captured = f.host.resolveFile(f.conversationId, reference).path;
  assert.deepEqual(await f.host.dispatch(f.sender, 'discard-prepared-edit', { conversationId: f.conversationId, requestId: record.request.id }), []);
  assert.ok(fs.existsSync(captured));
  await f.host.dispatch(f.sender, 'release-capture', { conversationId: f.conversationId, fileRef: reference });
  assert.equal(fs.existsSync(captured), false);
});

test('editing a queued source again keeps the new draft when the queued request is cancelled', async t => {
  const f = await fixture(t);
  const record = await prepareEdit(f, 'edit-1');
  const fileRef = record.request.attachmentRefs[0].fileRef;
  const captured = f.host.resolveFile(f.conversationId, fileRef).path;
  await f.host.dispatch(f.sender, 'release-capture', { conversationId: f.conversationId, fileRef });
  await f.host.dispatch(f.sender, 'capture', { conversationId: f.conversationId, fileRef });
  assert.deepEqual(await f.host.dispatch(f.sender, 'discard-prepared-edit', { conversationId: f.conversationId, requestId: record.request.id }), []);
  assert.ok(fs.existsSync(captured));
  const next = await prepareEdit(f, 'edit-2', record.request.attachmentRefs[0]);
  assert.equal(next.request.sourceCaptureId, fileRef.captureId);
});

test('closing during asynchronous preparation releases the request when preparation finishes', async t => {
  const f = await fixture(t);
  const source = await f.host.dispatch(f.sender, 'capture', { conversationId: f.conversationId, fileRef: { originalPath: f.filePath } });
  const captured = f.host.resolveFile(f.conversationId, source.fileRef).path;
  const preparing = prepareEdit(f, 'edit-pending', source);
  f.sender.emit('render-process-gone');
  await assert.rejects(preparing, /window is unavailable/);
  assert.equal(fs.existsSync(captured), false);
  await assert.rejects(f.host.dispatch(f.sender, 'get-edit', { conversationId: f.conversationId, requestId: 'edit-pending' }), /unavailable/);
});

test('restart retains recorded requests and removes abandoned preparations even when retention markers are incomplete', async t => {
  const f = await fixture(t);
  const kept = await prepareEdit(f, 'kept');
  const abandoned = await prepareEdit(f, 'abandoned');
  persistRequest(f, kept);
  const keptPath = f.host.resolveFile(f.conversationId, kept.request.attachmentRefs[0].fileRef).path;
  const abandonedPath = f.host.resolveFile(f.conversationId, abandoned.request.attachmentRefs[0].fileRef).path;
  fs.rmSync(keptPath.replace(/\.png$/, '.keep'));
  f.sender.removeAllListeners();
  const reopened = createMediaHost({ dataRoot: f.root, getConversation: id => id === f.conversationId ? { missing: false } : null });
  assert.ok(fs.existsSync(keptPath));
  assert.equal(fs.existsSync(abandonedPath), false);
  assert.deepEqual(await reopened.dispatch(f.sender, 'discard-prepared-edit', { conversationId: f.conversationId, requestId: kept.request.id }), []);
  assert.equal((await reopened.dispatch(f.sender, 'get-edit', { conversationId: f.conversationId, requestId: kept.request.id })).job.generationState, 'prepared');
  const folder = path.join(f.root, 'media', 'captures', createHash('sha256').update(f.conversationId).digest('hex'));
  assert.equal(fs.readdirSync(folder).filter(name => name.endsWith('.png')).length, 1);
});

test('restart completes media cleanup for a conversation already marked deleted', async t => {
  const f = await fixture(t);
  const record = await prepareEdit(f, 'edit-1');
  const captured = f.host.resolveFile(f.conversationId, record.request.attachmentRefs[0].fileRef).path;
  f.sender.removeAllListeners();
  const reopened = createMediaHost({ dataRoot: f.root, getConversation: () => ({ missing: true }) });
  assert.equal(fs.existsSync(captured), false);
  await assert.rejects(reopened.dispatch(f.sender, 'get-edit', { conversationId: f.conversationId, requestId: record.request.id }), /unavailable/);
});

test('saved copies remain usable after the source is removed and preserve its permission identity', async t => {
  const f = await fixture(t);
  const copy = path.join(f.outputs, 'files', 'source.png');
  fs.mkdirSync(path.dirname(copy));
  fs.copyFileSync(f.filePath, copy);
  fs.writeFileSync(path.join(f.outputs, 'manifest-log.jsonl'), JSON.stringify({ op: 'set', entry: {
    originalPath: f.filePath, snapshotRelPath: 'files/source.png', snapshottedAt: 1,
  } }));
  fs.rmSync(f.filePath);
  for (const requested of [f.filePath, copy]) {
    const resolved = f.host.resolveFile(f.conversationId, { originalPath: requested });
    assert.equal(resolved.path, copy);
    const captured = await f.host.dispatch(f.sender, 'capture', { conversationId: f.conversationId, fileRef: { originalPath: requested } });
    assert.equal(captured.fileRef.originalPath, f.filePath);
  }
});

test('files outside the workspace and symbolic links leaving it are refused', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'other.png');
  fs.copyFileSync(f.filePath, outside);
  const link = path.join(f.workspace, 'link.png');
  fs.symlinkSync(outside, link);
  for (const originalPath of [outside, link]) assert.throws(() => f.host.resolveFile(f.conversationId, { originalPath }), /does not belong/);
  fs.writeFileSync(path.join(f.outputs, 'manifest.json'), JSON.stringify({ version: 1, entries: {
    [f.filePath]: { originalPath: f.filePath, snapshotRelPath: '../../../other.png', snapshottedAt: 1 },
  } }));
  fs.rmSync(f.filePath);
  assert.throws(() => f.host.resolveFile(f.conversationId, { originalPath: f.filePath }), /outside/);
});

test('shared image copies use their local imported identity', async t => {
  const f = await fixture(t);
  const copy = path.join(f.outputs, 'shared.png');
  fs.copyFileSync(f.filePath, copy);
  const remotePath = '/another-user/work/photo.png';
  fs.writeFileSync(path.join(f.outputs, 'manifest-log.jsonl'), JSON.stringify({ op: 'set', entry: {
    originalPath: remotePath, snapshotRelPath: 'shared.png', snapshottedAt: 1, refId: 'shared-import', refKind: 'shared',
  } }));
  const captured = await f.host.dispatch(f.sender, 'capture', { conversationId: f.conversationId, fileRef: { originalPath: copy } });
  assert.equal(captured.fileRef.originalPath, copy);
});
