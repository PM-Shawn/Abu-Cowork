'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMediaJobHost } = require('./mediaJobHost.cjs');

const scratch = path.join(__dirname, '..', '.agent', 'media-job-tests');
fs.mkdirSync(scratch, { recursive: true });
const digest = 'a'.repeat(64);
const request = {
  schemaVersion: 1, id: 'request-1', scope: 'local', conversationId: 'conversation-1', messageId: 'message-1',
  sourceArtifactId: 'image-1', sourceCaptureId: 'capture-1', sourceDigest: digest,
  prompt: 'Change the background.', comments: [], markup: [], region: [],
  attachmentRefs: [{ kind: 'source', fileRef: { originalPath: '/coffee.png', captureId: 'capture-1', contentDigest: digest }, mimeType: 'image/png', width: 1000, height: 1000, byteLength: 1024 }],
  backendId: 'openai', capabilityVersion: 'images-edit-v1',
};
const artifact = {
  schemaVersion: 1, id: 'image-2', conversationId: 'conversation-1', messageId: 'reply-1', kind: 'image',
  mimeType: 'image/png', fileRef: { originalPath: '/coffee-edited.png' }, byteLength: 2048,
  groupId: 'request-1', order: 0, parentArtifactId: 'image-1', editRequestId: 'request-1',
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(scratch, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    root, scope: 'local',
    assertConversation(conversationId) { assert.equal(conversationId, 'conversation-1'); },
  };
  return { host: createMediaJobHost(options), reopen: () => createMediaJobHost(options) };
}

test('one prepared request incurs one provider execution across concurrent starts and reopening', async (t) => {
  const { host, reopen } = fixture(t);
  host.prepare(request);
  let executions = 0;
  const execute = async (_input, progress) => {
    executions += 1;
    progress.saving();
    return [artifact];
  };
  const first = host.start('conversation-1', 'request-1', execute);
  const second = host.start('conversation-1', 'request-1', execute);
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.job.generationState, 'completed');
  assert.equal(executions, 1);
  assert.deepEqual((await reopen().start('conversation-1', 'request-1', execute)).artifacts, [artifact]);
  assert.equal(executions, 1);
});

test('reopening an active request reports unknown without posting again', async (t) => {
  const { host, reopen } = fixture(t);
  host.prepare(request);
  let finish;
  const response = new Promise((resolve) => { finish = resolve; });
  const active = host.start('conversation-1', 'request-1', async (_input, progress) => {
    await response;
    progress.saving();
    return [artifact];
  });
  const recovered = reopen();
  assert.equal(recovered.get('conversation-1', 'request-1').job.generationState, 'unknown');
  const current = await recovered.start('conversation-1', 'request-1', () => { throw new Error('Unexpected provider call'); });
  assert.equal(current.job.generationState, 'unknown');
  finish();
  await active;
});

test('stopping a wait retains eventual delivery and frozen instructions', async (t) => {
  const { host } = fixture(t);
  const prepared = host.prepare(request);
  prepared.request.prompt = 'Mutated caller copy';
  host.detach('conversation-1', 'request-1');
  const result = await host.start('conversation-1', 'request-1', async (input, progress) => {
    assert.equal(input.prompt, request.prompt);
    progress.saving();
    return [artifact];
  });
  assert.equal(result.job.waitState, 'detached');
  assert.equal(result.job.generationState, 'completed');
});

test('a paid request with an ambiguous response is retained and cannot be retried implicitly', async (t) => {
  const { host } = fixture(t);
  host.prepare(request);
  await assert.rejects(host.start('conversation-1', 'request-1', async () => {
    const error = new Error('Connection interrupted');
    error.submissionUnknown = true;
    throw error;
  }), /Connection interrupted/);
  assert.equal(host.get('conversation-1', 'request-1').job.generationState, 'unknown');
  assert.throws(() => host.prepare({ ...request, prompt: 'Other instructions' }), /different instructions/);
});

test('deleting a conversation prevents a late result from recreating its records', async (t) => {
  const { host } = fixture(t);
  host.prepare(request);
  let finish;
  const response = new Promise((resolve) => { finish = resolve; });
  const active = host.start('conversation-1', 'request-1', async (_input, progress) => {
    await response;
    progress.saving();
    return [artifact];
  });
  await Promise.resolve();
  host.forget('conversation-1');
  finish();
  await assert.rejects(active, /unavailable/);
  assert.throws(() => host.get('conversation-1', 'request-1'), /unavailable/);
  assert.throws(() => host.prepare(request), /unavailable/);
});

test('scope and conversation checks precede access to stored requests', (t) => {
  const { host } = fixture(t);
  assert.throws(() => host.prepare({ ...request, scope: 'other-account' }), /scope/);
  host.prepare(request);
  assert.throws(() => host.get('conversation-2', 'request-1'));
});
