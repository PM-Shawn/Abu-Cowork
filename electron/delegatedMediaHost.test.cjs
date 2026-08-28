'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_DELEGATED_MEDIA_BYTES,
  persistDelegatedMedia,
  readDelegatedMedia,
} = require('./delegatedMediaHost.cjs');

function tmpAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'abu-delegated-media-host-'));
}

function b64(value) {
  return Buffer.from(value, 'base64');
}

const PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
const INTERLACED_PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAFNeavDAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==');
const BAD_FILTER_PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNlAAAADAAGjm0zfwAAAABJRU5ErkJggg==');
const TRUNCATED_VP8L = b64('UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAA=');
const TRUNCATED_VP8L_HEX = '5249464614000000574542505650384c080000002f00000000010203';
const BAD_JPEG = b64('/9j/wAAICAAAAAAA/9oAAv/Z');
const BAD_GIF = b64('R0lGODlhAAAAAAAAACwAAAAAAAAAAAAAADs=');

test('persists and reads delegated media as an opaque app-data ref', () => {
  const appDataDir = tmpAppData();
  const ref = persistDelegatedMedia(appDataDir, {
    conversationId: 'conv_1',
    mediaType: 'image/png',
    bytes: PNG,
    width: 1,
    height: 1,
  });

  assert.equal(ref.mediaType, 'image/png');
  assert.equal(ref.bytes, PNG.byteLength);
  assert.equal(ref.width, 1);
  assert.equal(ref.height, 1);
  assert.match(ref.id, /^media_[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(ref).includes(appDataDir), false);
  assert.deepEqual(Buffer.from(readDelegatedMedia(appDataDir, { conversationId: 'conv_1', ref })), PNG);
});

test('rejects SHA, size, MIME, path, and id mismatches without exposing paths', () => {
  const appDataDir = tmpAppData();
  const ref = persistDelegatedMedia(appDataDir, {
    conversationId: 'conv_1',
    mediaType: 'image/png',
    bytes: PNG,
  });

  assert.equal(readDelegatedMedia(appDataDir, { conversationId: 'conv_1', ref: { ...ref, sha256: 'b'.repeat(64) } }), null);
  assert.equal(readDelegatedMedia(appDataDir, { conversationId: 'conv_1', ref: { ...ref, bytes: ref.bytes + 1 } }), null);
  assert.equal(readDelegatedMedia(appDataDir, { conversationId: 'conv_1', ref: { ...ref, mediaType: 'image/jpeg' } }), null);
  assert.throws(
    () => persistDelegatedMedia(appDataDir, { conversationId: '../escape', mediaType: 'image/png', bytes: PNG }),
    /conversation id/i,
  );
  assert.equal(readDelegatedMedia(appDataDir, { conversationId: 'conv_1', ref: { ...ref, id: '../escape' } }), null);
});

test('does not overwrite an immutable existing media file with corrupt content', () => {
  const appDataDir = tmpAppData();
  const ref = persistDelegatedMedia(appDataDir, {
    conversationId: 'conv_1',
    mediaType: 'image/png',
    bytes: PNG,
  });
  const mediaPath = path.join(appDataDir, 'conversations', 'conv_1', 'delegated-media', `${ref.id}.png`);
  fs.writeFileSync(mediaPath, Buffer.from('corrupt'));

  assert.throws(
    () => persistDelegatedMedia(appDataDir, { conversationId: 'conv_1', mediaType: 'image/png', bytes: PNG }),
    /integrity/i,
  );
  assert.deepEqual(fs.readFileSync(mediaPath), Buffer.from('corrupt'));
});

test('accepts a valid interlaced PNG at the host boundary', () => {
  const appDataDir = tmpAppData();
  const ref = persistDelegatedMedia(appDataDir, { conversationId: 'conv_1', mediaType: 'image/png', bytes: INTERLACED_PNG });
  assert.equal(ref.mediaType, 'image/png');
});

test('rejects reviewer corrupt image samples at the host boundary', () => {
  const appDataDir = tmpAppData();
  const cases = [
    ['PNG invalid filter', 'image/png', BAD_FILTER_PNG],
    ['truncated VP8L', 'image/webp', TRUNCATED_VP8L],
    ['truncated VP8L hex', 'image/webp', Buffer.from(TRUNCATED_VP8L_HEX, 'hex')],
    ['malformed JPEG', 'image/jpeg', BAD_JPEG],
    ['malformed GIF', 'image/gif', BAD_GIF],
  ];
  for (const [label, mediaType, bytes] of cases) {
    assert.throws(
      () => persistDelegatedMedia(appDataDir, { conversationId: 'conv_1', mediaType, bytes }),
      /bytes are invalid/i,
      label,
    );
  }
});

test('rejects the reviewer exact empty PDF shell at the host boundary', () => {
  const appDataDir = tmpAppData();
  assert.throws(
    () => persistDelegatedMedia(appDataDir, {
      conversationId: 'conv_1',
      mediaType: 'application/pdf',
      bytes: Buffer.from('JVBERi0KJSVFT0Y=', 'base64'),
    }),
    /bytes are invalid/i,
  );
});

function oversizedPdfAtUnifiedLimit() {
  const bytes = Buffer.alloc(MAX_DELEGATED_MEDIA_BYTES + 1, 0x20);
  bytes.write('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 0, 'ascii');
  bytes.write('startxref\n0\n%%EOF', bytes.length - 'startxref\n0\n%%EOF'.length, 'ascii');
  return bytes;
}

test('caps delegated media before disk persistence without a PDF-specific larger budget', () => {
  const appDataDir = tmpAppData();
  const oversizedPng = Buffer.alloc(MAX_DELEGATED_MEDIA_BYTES + 1);
  PNG.subarray(0, 8).copy(oversizedPng, 0);
  const oversizedPdf = oversizedPdfAtUnifiedLimit();

  assert.throws(
    () => persistDelegatedMedia(appDataDir, { conversationId: 'conv_1', mediaType: 'image/png', bytes: oversizedPng }),
    /too large/i,
  );
  assert.throws(
    () => persistDelegatedMedia(appDataDir, { conversationId: 'conv_1', mediaType: 'application/pdf', bytes: oversizedPdf }),
    /too large/i,
  );
});
