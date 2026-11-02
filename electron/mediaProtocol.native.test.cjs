'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createMediaProtocol } = require('./mediaProtocol.cjs');
const { killNativeHelper } = require('./nativeHelperManager.cjs');

test.after(() => killNativeHelper('media-protocol-tests-finished'));

async function fixture(t, options = {}) {
  const parent = path.resolve(__dirname, '../.agent');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'media-protocol-'));
  const file = path.join(root, 'movie.mp4');
  await fs.writeFile(file, '0123456789');
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false });
  const protocol = createMediaProtocol({
    ...options,
    assertConversation: id => assert.equal(id, 'conversation-1'),
    resolveFile: (id, reference) => {
      assert.equal(id, 'conversation-1');
      assert.deepEqual(reference, { originalPath: file });
      return { path: file, mimeType: 'video/mp4' };
    },
  });
  const grant = await protocol.grant(sender, 'conversation-1', { originalPath: file });
  t.after(async () => {
    protocol.revokeConversation('conversation-1');
    await fs.rm(root, { recursive: true, force: true });
  });
  return { protocol, grant, sender, file };
}

test('streams complete, prefix, suffix and open-ended ranges through the real helper', async t => {
  const { protocol, grant } = await fixture(t);
  for (const [range, status, expected, contentRange] of [
    [null, 200, '0123456789', null], ['bytes=2-5', 206, '2345', 'bytes 2-5/10'],
    ['bytes=-3', 206, '789', 'bytes 7-9/10'], ['bytes=7-', 206, '789', 'bytes 7-9/10'],
  ]) {
    const response = await protocol.handle(new Request(grant.url, { headers: range ? { range } : {} }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(response.headers.get('content-length'), String(expected.length));
    assert.equal(await response.text(), expected);
  }
  const head = await protocol.handle(new Request(grant.url, { method: 'HEAD' }));
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
});

test('expired grants stop access and a renewal extends the same owner grant', async t => {
  let time = 1000;
  const { protocol, sender, grant } = await fixture(t, { now: () => time });
  const details = { url: grant.url, webContentsId: sender.id, frame: sender.mainFrame };
  time += 14 * 60 * 1000;
  protocol.renew(sender, grant.token);
  time += 14 * 60 * 1000;
  assert.equal(protocol.permits(details), true);
  time += 2 * 60 * 1000;
  assert.equal(protocol.permits(details), false);
  assert.equal((await protocol.handle(new Request(grant.url))).status, 404);
});

test('result grants verify the recorded content digest before exposing bytes', async t => {
  const f = await fixture(t);
  const protocol = createMediaProtocol({ assertConversation: () => {}, resolveFile: (_id, reference) => ({ path: f.file, mimeType: 'image/png', contentDigest: reference.contentDigest }) });
  await assert.rejects(protocol.grant(f.sender, 'conversation-1', { originalPath: f.file, contentDigest: 'a'.repeat(64) }), /content changed/);
  const grant = await protocol.grant(f.sender, 'conversation-1', { originalPath: f.file, contentDigest: createHash('sha256').update('0123456789').digest('hex') });
  assert.equal(await (await protocol.handle(new Request(grant.url))).text(), '0123456789');
  protocol.release(f.sender, grant.token);
});

test('rejects invalid, unsatisfied and multiple ranges', async t => {
  const { protocol, grant } = await fixture(t);
  for (const range of ['bytes=100-', 'bytes=0-1,7-8', 'bytes=0-1,2-3', 'bytes=0-5,3-8', 'items=1-3', 'broken']) {
    const response = await protocol.handle(new Request(grant.url, { headers: { range } }));
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
  }
});

test('only the granting main frame may use a URL and navigation revokes it', async t => {
  const { protocol, grant, sender } = await fixture(t);
  const details = { url: grant.url, webContentsId: sender.id, frame: sender.mainFrame };
  assert.equal(protocol.permits(details), true);
  assert.equal(protocol.permits({ ...details, frame: {} }), false);
  assert.equal(protocol.permits({ ...details, webContentsId: 2 }), false);
  assert.throws(() => protocol.release({}, grant.token));
  sender.emit('did-start-navigation', {}, 'file:///new.html', false, true);
  assert.equal(protocol.permits(details), false);
  assert.equal((await protocol.handle(new Request(grant.url))).status, 404);
});

test('changing a source invalidates GET and HEAD for the retained grant', async t => {
  const { protocol, grant, file } = await fixture(t);
  await fs.writeFile(file, 'changed content');
  await assert.rejects(protocol.handle(new Request(grant.url)), /source changed/);
  await assert.rejects(protocol.handle(new Request(grant.url, { method: 'HEAD' })), /source changed/);
});

test('conversation revocation ends a partially consumed large stream', async t => {
  const { protocol, sender, file } = await fixture(t);
  const handle = await fs.open(file, 'r+');
  try { await handle.truncate(201 * 1024 * 1024); } finally { await handle.close(); }
  const large = await protocol.grant(sender, 'conversation-1', { originalPath: file });
  const response = await protocol.handle(new Request(large.url));
  const reader = response.body.getReader();
  assert.equal((await reader.read()).value.byteLength, 1024 * 1024);
  protocol.revokeConversation('conversation-1');
  assert.equal((await reader.read()).done, true);
});
