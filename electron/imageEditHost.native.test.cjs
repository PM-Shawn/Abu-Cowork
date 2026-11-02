'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const { createMediaCaptureStore } = require('./mediaCaptureStore.cjs');
const { createImageEditHost, readImageResponse } = require('./imageEditHost.cjs');
const { killNativeHelper } = require('./nativeHelperManager.cjs');
const { createMediaStorageBudget } = require('./mediaStorageBudget.cjs');
const { imageLayerSvg } = require('./generated/mediaRuntime.cjs');

test.after(() => killNativeHelper('image-edit-tests-finished'));
const backend = { id: 'images', vendor: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2.5-sunburst', apiKey: 'test-boundary-credential' };

async function fixture(t) {
  const scratch = path.resolve(__dirname, '../.agent/image-edit-native');
  fs.mkdirSync(scratch, { recursive: true });
  const dataRoot = fs.mkdtempSync(path.join(scratch, 'case-'));
  const root = path.join(dataRoot, 'media');
  fs.mkdirSync(root);
  const original = path.join(root, 'source.png');
  const bytes = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#e0b070' } }).png().toBuffer();
  fs.writeFileSync(original, bytes);
  const assertConversation = id => assert.equal(id, 'conversation-1');
  const assertCapacity = createMediaStorageBudget(dataRoot);
  const captures = createMediaCaptureStore({ root: path.join(root, 'captures'), assertConversation, assertCapacity });
  const source = await captures.capture('conversation-1', { path: original });
  const options = { root, scope: 'local', captures, assertConversation, assertCapacity };
  const host = createImageEditHost(options);
  const input = {
    id: 'edit-1', messageId: 'message-1', scope: 'local', conversationId: 'conversation-1',
    sourceArtifactId: 'image-1', sourceCaptureId: source.fileRef.captureId, sourceDigest: source.fileRef.contentDigest,
    source, activeTool: 'prompt', prompt: 'Change the background', comments: [], markup: [], region: [],
  };
  const dispatcher = getGlobalDispatcher();
  const network = new MockAgent();
  network.disableNetConnect();
  setGlobalDispatcher(network);
  t.after(async () => { setGlobalDispatcher(dispatcher); await network.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  return { root, captures, source, original, bytes, input, host, assertCapacity, reopen: () => createImageEditHost(options), network };
}

test('invalid credential characters are rejected before creating a job', async t => {
  const f = await fixture(t);
  for (const apiKey of ['boundary-key\u0001', 'boundary-key\nsecond-line', 'boundary-key\r', 'boundary-key\u007f', 'boundary-key\u0100', 'boundary-key\u{1f600}', 'boundary key']) {
    await assert.rejects(f.host.prepare(f.input, { ...backend, apiKey }), error => {
      assert.equal(error.message, 'Image service credentials contain unsupported characters');
      assert.equal(error.message.includes('boundary'), false);
      return true;
    });
    assert.equal(f.host.jobs.find(f.input.conversationId, f.input.id), undefined);
  }
});

test('real source captures survive external replacement and reject changed capture bytes', async t => {
  const f = await fixture(t);
  fs.rmSync(f.original);
  fs.symlinkSync(path.join(f.root, 'missing.png'), f.original);
  const read = await f.captures.read('conversation-1', f.source.fileRef);
  assert.equal(createHash('sha256').update(read.bytes).digest('hex'), f.input.sourceDigest);
  fs.writeFileSync(read.path, f.bytes.subarray(0, 20));
  await assert.rejects(f.captures.read('conversation-1', f.source.fileRef), /content changed/);
});

test('source captures normalize EXIF orientation while preserving the original file', async t => {
  const f = await fixture(t);
  const original = path.join(f.root, 'orientation.jpg');
  const overlay = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="20" height="20" fill="#ff0000"/><rect x="60" y="40" width="20" height="20" fill="#0000ff"/></svg>');
  const bytes = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ffffff' } })
    .composite([{ input: overlay }]).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();
  fs.writeFileSync(original, bytes);
  const capture = await f.captures.capture('conversation-1', { path: original });
  const read = await f.captures.read('conversation-1', capture.fileRef);
  assert.equal(capture.width, 60);
  assert.equal(capture.height, 80);
  const metadata = await sharp(read.bytes).metadata();
  assert.equal(metadata.orientation, undefined);
  const red = await sharp(read.bytes).extract({ left: 49, top: 10, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  const blue = await sharp(read.bytes).extract({ left: 9, top: 70, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.ok(red[0] > 240 && red[1] < 20 && red[2] < 20);
  assert.ok(blue[0] < 20 && blue[1] < 20 && blue[2] > 240);
  assert.deepEqual(fs.readFileSync(original), bytes);
});

test('discarding a draft removes its capture and a submitted request retains its source', async t => {
  const f = await fixture(t);
  const discarded = await f.captures.capture('conversation-1', { path: f.original });
  const discardedPath = f.captures.get('conversation-1', discarded.fileRef).path;
  f.captures.release('conversation-1', discarded.fileRef);
  assert.equal(fs.existsSync(discardedPath), false);
  await f.host.prepare(f.input, backend);
  f.captures.release('conversation-1', f.source.fileRef);
  assert.deepEqual((await f.captures.read('conversation-1', f.source.fileRef)).bytes, f.bytes);
});

test('capture storage checks converted bytes and the conversation quota before writing', async t => {
  const f = await fixture(t);
  assert.throws(() => f.captures.store('conversation-1', f.original, 'source', Buffer.alloc(50 * 1024 * 1024 + 1), 1, 1), /prepared image/);
  const sourcePath = f.captures.get('conversation-1', f.source.fileRef).path;
  fs.truncateSync(sourcePath, 1024 * 1024 * 1024);
  assert.throws(() => f.captures.store('conversation-1', f.original, 'source', f.bytes, 80, 60), /capacity/);
});

test('all four edit combinations export valid PNG layers and one source version', async t => {
  const f = await fixture(t);
  const comment = { id: 'comment-1', point: { x: 0.5, y: 0.5 }, text: 'Keep the text' };
  const mark = { id: 'mark-1', kind: 'rectangle', start: { x: 0.1, y: 0.2 }, end: { x: 0.6, y: 0.7 }, color: '#ff0000', width: 0.02 };
  const region = { id: 'region-1', erase: false, width: 0.2, points: [{ x: 0.5, y: 0.5 }] };
  for (const [index, layers, kinds] of [
    [0, {}, ['source']],
    [1, { comments: [comment] }, ['source', 'markup']],
    [2, { markup: [mark] }, ['source', 'markup']],
    [3, { comments: [comment], markup: [mark], region: [region] }, ['source', 'reference', 'mask']],
  ]) {
    const record = await f.host.prepare({ ...f.input, id: `edit-${index}`, messageId: `message-${index}`, ...layers }, backend);
    assert.deepEqual(record.request.attachmentRefs.map(item => item.kind), kinds);
    assert.equal(record.request.sourceDigest, f.input.sourceDigest);
    for (const attachment of record.request.attachmentRefs) {
      const read = await f.captures.read('conversation-1', attachment.fileRef);
      const metadata = await sharp(read.bytes).metadata();
      assert.equal(metadata.width, 80);
      assert.equal(metadata.height, 60);
      if (attachment.kind === 'mask') {
        const pixels = await sharp(read.bytes).ensureAlpha().raw().toBuffer();
        assert.equal(pixels[(30 * 80 + 40) * 4 + 3], 0);
        assert.equal(pixels[3], 255);
      }
    }
  }
});

test('concurrent preparation and execution reuse one request and one HTTP submission', async t => {
  const f = await fixture(t);
  const input = { ...f.input, comments: [{ id: 'comment-1', point: { x: 0.5, y: 0.5 }, text: 'Keep the label' }] };
  const records = await Promise.all([f.host.prepare(input, backend), f.host.prepare(input, backend)]);
  assert.deepEqual(records[0], records[1]);
  let posts = 0;
  f.network.get('https://api.openai.com').intercept({ path: '/v1/images/edits', method: 'POST' }).reply(200, options => {
    posts += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.images.length, 1);
    assert.ok(body.markup.image_url.startsWith('data:image/png;base64,'));
    assert.match(body.prompt, /Keep the label/);
    return { data: [{ b64_json: f.bytes.toString('base64') }] };
  });
  const [a, b] = await Promise.all([f.host.execute('conversation-1', 'edit-1'), f.host.execute('conversation-1', 'edit-1')]);
  assert.equal(posts, 1);
  assert.deepEqual(a, b);
  assert.equal(a.job.generationState, 'completed');
  assert.equal((await sharp(a.artifacts[0].fileRef.originalPath).metadata()).width, 80);
  assert.equal((await f.reopen().execute('conversation-1', 'edit-1')).job.generationState, 'completed');
  assert.equal(posts, 1);
});

test('saving a retained response after reopening uses no second image request', async t => {
  const f = await fixture(t);
  await f.host.prepare(f.input, backend);
  const directory = path.join(f.root, 'results', createHash('sha256').update('conversation-1').digest('hex'), createHash('sha256').update('edit-1').digest('hex'));
  fs.mkdirSync(path.join(directory, 'image.png'), { recursive: true });
  f.network.get('https://api.openai.com').intercept({ path: '/v1/images/edits', method: 'POST' }).reply(200, { data: [{ b64_json: f.bytes.toString('base64') }] });
  await assert.rejects(f.host.execute('conversation-1', 'edit-1'));
  assert.equal(f.host.jobs.get('conversation-1', 'edit-1').job.generationState, 'save_failed');
  assert.ok(fs.existsSync(path.join(directory, 'received.json')));
  fs.rmdirSync(path.join(directory, 'image.png'));
  const saved = await f.reopen().retrySave('conversation-1', 'edit-1');
  assert.equal(saved.job.generationState, 'completed');
  assert.equal(fs.existsSync(path.join(directory, 'received.json')), false);
  f.network.assertNoPendingInterceptors();
});

test('an ambiguous transport failure stays unknown after reopening', async t => {
  const f = await fixture(t);
  await f.host.prepare(f.input, backend);
  f.network.get('https://api.openai.com').intercept({ path: '/v1/images/edits', method: 'POST' }).replyWithError(new Error('Disconnected after submission'));
  await assert.rejects(f.host.execute('conversation-1', 'edit-1'));
  assert.equal((await f.reopen().execute('conversation-1', 'edit-1')).job.generationState, 'unknown');
  f.network.assertNoPendingInterceptors();
});

test('a received response recovers when the running record was the last committed state', async t => {
  const f = await fixture(t);
  await f.host.prepare(f.input, backend);
  const conversationKey = createHash('sha256').update('conversation-1').digest('hex');
  const requestKey = createHash('sha256').update('edit-1').digest('hex');
  const directory = path.join(f.root, 'results', conversationKey, requestKey);
  fs.mkdirSync(path.join(directory, 'image.png'), { recursive: true });
  f.network.get('https://api.openai.com').intercept({ path: '/v1/images/edits', method: 'POST' }).reply(200, { data: [{ b64_json: f.bytes.toString('base64') }] });
  await assert.rejects(f.host.execute('conversation-1', 'edit-1'));
  const target = path.join(f.root, 'jobs', conversationKey, `${requestKey}.json`);
  const record = JSON.parse(fs.readFileSync(target, 'utf8'));
  record.job.generationState = 'running';
  record.job.sequence = 2;
  delete record.job.error;
  fs.writeFileSync(target, JSON.stringify(record));
  fs.rmdirSync(path.join(directory, 'image.png'));
  const reopened = f.reopen();
  assert.equal(reopened.jobs.get('conversation-1', 'edit-1').job.generationState, 'save_failed');
  const saved = await reopened.retrySave('conversation-1', 'edit-1');
  assert.equal(saved.job.generationState, 'completed');
  assert.equal((await sharp(saved.artifacts[0].fileRef.originalPath).metadata()).width, 80);
  f.network.assertNoPendingInterceptors();
});

test('the response reader rejects invalid and absent JSON bodies', async () => {
  await assert.rejects(readImageResponse(new Response('invalid')), SyntaxError);
  await assert.rejects(readImageResponse(new Response(null)), /empty response/);
});

for (const model of ['doubao-seedream-5.0-lite', 'doubao-seedream-5.0-flash']) test(`${model} sends the captured source and composited reference to the configured endpoint`, async t => {
  const f = await fixture(t);
  const service = { ...backend, vendor: 'volcengine', model, baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations' };
  const comments = [
    { id: 'comment-1', point: { x: 0.1, y: 0.1 }, text: ' ' },
    { id: 'comment-2', point: { x: 0.5, y: 0.5 }, text: 'Make this green' },
  ];
  const record = await f.host.prepare({ ...f.input, comments }, service);
  assert.deepEqual(record.request.comments, comments);
  assert.deepEqual(record.request.attachmentRefs.map(item => item.kind), ['source', 'reference']);
  const reference = await f.captures.read('conversation-1', record.request.attachmentRefs[1].fileRef);
  assert.equal((await sharp(reference.bytes).stats()).isOpaque, true);
  f.network.get('https://ark.cn-beijing.volces.com').intercept({ path: '/api/plan/v3/images/generations', method: 'POST' }).reply(200, options => {
    const body = JSON.parse(options.body);
    assert.equal(body.image.length, 2);
    assert.equal(body.image[0], `data:image/png;base64,${f.bytes.toString('base64')}`);
    assert.equal(body.image[1], `data:image/png;base64,${reference.bytes.toString('base64')}`);
    assert.equal(body.response_format, 'b64_json');
    assert.equal(body.sequential_image_generation, model.endsWith('-lite') ? 'disabled' : undefined);
    assert.equal(body.size, '2K');
    assert.match(body.prompt, /Make this green/);
    assert.match(body.prompt, /Comment 2 at \(0.5, 0.5\).*Make this green/);
    assert.doesNotMatch(body.prompt, /Comment 1 at/);
    assert.equal(body.mask, undefined);
    return { data: [{ b64_json: f.bytes.toString('base64') }] };
  });
  assert.equal((await f.host.execute('conversation-1', 'edit-1')).job.generationState, 'completed');
  f.network.assertNoPendingInterceptors();
});

test('a full conversation refuses execution before contacting the image service', async t => {
  const f = await fixture(t);
  await f.host.prepare(f.input, backend);
  const folder = path.join(f.root, 'results', createHash('sha256').update('conversation-1').digest('hex'));
  fs.mkdirSync(folder, { recursive: true });
  const filler = path.join(folder, 'quota.bin');
  fs.writeFileSync(filler, '');
  fs.truncateSync(filler, 1024 ** 3 - 1024);
  let posts = 0;
  f.network.get('https://api.openai.com').intercept({ path: '/v1/images/edits', method: 'POST' }).reply(200, () => {
    posts += 1;
    return { data: [{ b64_json: f.bytes.toString('base64') }] };
  });
  await assert.rejects(f.host.execute('conversation-1', 'edit-1'), /capacity/);
  assert.equal(posts, 0);
  assert.equal(f.reopen().jobs.get('conversation-1', 'edit-1').job.generationState, 'failed');
});

test('in-flight image storage reservations protect space from other captures and release after completion', async t => {
  const f = await fixture(t);
  const reservation = f.assertCapacity.reserve('conversation-1', 1024 ** 3 - 4096);
  assert.throws(() => f.captures.store('conversation-1', f.original, 'source', Buffer.alloc(8192), 80, 60), /capacity/);
  assert.throws(() => f.assertCapacity.reserve('conversation-1', 8192), /capacity/);
  reservation.release();
  const saved = f.captures.store('conversation-1', f.original, 'source', f.bytes, 80, 60);
  assert.ok(fs.existsSync(f.captures.get('conversation-1', saved.fileRef).path));
});

test('a failed layer export removes its generated attachments and preserves the editable source', async t => {
  const f = await fixture(t);
  const input = { ...f.input,
    comments: [{ id: 'comment-1', point: { x: 0.5, y: 0.5 }, text: 'Keep the label' }],
    region: [{ id: 'region-1', erase: false, width: 0.2, points: [{ x: 0.5, y: 0.5 }] }],
  };
  const overlay = await sharp(Buffer.from(imageLayerSvg(input, 'markup'))).png().toBuffer();
  const reference = await sharp(f.bytes).composite([{ input: overlay }]).png().toBuffer();
  const folder = path.dirname(f.captures.get('conversation-1', f.source.fileRef).path);
  const originalFiles = fs.readdirSync(folder);
  const used = originalFiles.reduce((total, name) => total + fs.statSync(path.join(folder, name)).size, 0);
  const reservation = f.assertCapacity.reserve('conversation-1', 1024 ** 3 - used - reference.length);
  await assert.rejects(f.host.prepare(input, backend), /capacity/);
  reservation.release();
  assert.equal(f.host.jobs.find('conversation-1', 'edit-1'), undefined);
  assert.deepEqual(fs.readdirSync(folder), originalFiles);
  assert.deepEqual((await f.captures.read('conversation-1', f.source.fileRef)).bytes, f.bytes);
});

test('capture cleanup keeps ownership checks when source permissions change', async t => {
  const f = await fixture(t);
  const folder = path.join(f.root, 'assets');
  const alias = path.join(f.root, 'alias');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'source.png'), f.bytes);
  fs.symlinkSync(folder, alias);
  const source = await f.captures.capture('conversation-1', { path: path.join(alias, 'source.png') });
  const capturedPath = f.captures.get('conversation-1', source.fileRef).path;
  fs.unlinkSync(alias);
  fs.symlinkSync('/etc', alias);
  await assert.rejects(f.captures.read('conversation-1', source.fileRef), /allowed scope/);
  assert.throws(() => f.captures.release('conversation-1', { ...source.fileRef, contentDigest: 'a'.repeat(64) }), /does not match/);
  f.captures.release('conversation-1', source.fileRef);
  assert.equal(fs.existsSync(capturedPath), false);
});

test('unsupported region instructions fail before creating a job or submitting an image', async t => {
  const f = await fixture(t);
  const service = { ...backend, vendor: 'volcengine', model: 'doubao-seedream-5.0-lite', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/images/generations' };
  const input = { ...f.input, region: [{ id: 'region-1', erase: false, width: 0.2, points: [{ x: 0.5, y: 0.5 }] }] };
  await assert.rejects(f.host.prepare(input, service), /does not support/);
  assert.equal(f.host.jobs.find('conversation-1', 'edit-1'), undefined);
});
