'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  __testing,
  authorizeUserAttachment,
  bytesMatchMediaType,
  issueUserAttachmentToken,
  readUserAttachment,
  releaseUserAttachment,
  selectUserAttachments,
  validateRequest,
} = require('./userAttachmentHost.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function fakeFs(bytes) {
  return {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
    open: async () => ({
      stat: async () => ({ isFile: () => true, size: bytes.byteLength }),
      read: async (buffer, offset, length, position) => {
        bytes.copy(buffer, offset, position, position + length);
        return { bytesRead: Math.min(length, bytes.byteLength - position) };
      },
      close: async () => {},
    }),
  };
}

test('reads a validated image attachment by declared media type', async () => {
  const sender = {};
  const issued = issueUserAttachmentToken({
    sender,
    path: '/tmp/pixel.png',
    name: 'pixel.png',
    mediaType: 'image/png',
    now: 1_000,
  });
  const bytes = await readUserAttachment({ sender }, {
    token: issued.token,
  }, { fs: fakeFs(PNG), now: 1_000 });

  assert.deepEqual(Buffer.from(bytes), PNG);
});

test('allows a sender-bound image token to be read repeatedly within its TTL', async () => {
  const sender = {};
  const issued = issueUserAttachmentToken({
    sender,
    path: '/tmp/pixel.png',
    name: 'pixel.png',
    mediaType: 'image/png',
    now: 1_000,
    ttlMs: 10_000,
  });

  const first = await readUserAttachment({ sender }, { token: issued.token }, { fs: fakeFs(PNG), now: 1_001 });
  const second = await readUserAttachment({ sender }, { token: issued.token }, { fs: fakeFs(PNG), now: 1_002 });

  assert.deepEqual(Buffer.from(first), PNG);
  assert.deepEqual(Buffer.from(second), PNG);
});

test('bounds attachment tokens and prunes them when a sender is destroyed', () => {
  const sender = { isDestroyed: () => false };
  const destroyed = { isDestroyed: () => true };
  __testing.resetTokens();

  for (let i = 0; i < __testing.MAX_TOKENS_PER_SENDER; i++) {
    issueUserAttachmentToken({
      sender,
      path: `/tmp/${i}.png`,
      name: `${i}.png`,
      mediaType: 'image/png',
      now: 1_000 + i,
    });
  }
  issueUserAttachmentToken({
    sender: destroyed,
    path: '/tmp/destroyed.png',
    name: 'destroyed.png',
    mediaType: 'image/png',
    now: 2_000,
  });

  __testing.pruneDestroyedSenders();

  assert.equal(__testing.countTokensForSender(sender), __testing.MAX_TOKENS_PER_SENDER);
  assert.equal(__testing.countTokensForSender(destroyed), 0);
  assert.ok(__testing.countTokens() <= __testing.MAX_TOTAL_TOKENS);
  __testing.resetTokens();
});

test('does not evict live sender tokens when the per-sender token registry is full', async () => {
  const sender = { isDestroyed: () => false };
  __testing.resetTokens();
  const first = issueUserAttachmentToken({
    sender,
    path: '/tmp/first.png',
    name: 'first.png',
    mediaType: 'image/png',
    now: 1_000,
  });
  for (let i = 1; i < __testing.MAX_TOKENS_PER_SENDER; i++) {
    issueUserAttachmentToken({
      sender,
      path: `/tmp/${i}.png`,
      name: `${i}.png`,
      mediaType: 'image/png',
      now: 1_000 + i,
    });
  }

  assert.throws(
    () => issueUserAttachmentToken({
      sender,
      path: '/tmp/overflow.png',
      name: 'overflow.png',
      mediaType: 'image/png',
      now: 2_000,
    }),
    /token limit reached/,
  );
  assert.equal(__testing.countTokensForSender(sender), __testing.MAX_TOKENS_PER_SENDER);

  const bytes = await readUserAttachment({ sender }, { token: first.token }, { fs: fakeFs(PNG), now: 2_001 });
  assert.deepEqual(Buffer.from(bytes), PNG);
  __testing.resetTokens();
});

test('main picker rejects an over-cap selection atomically instead of silently truncating it', async () => {
  const sender = { isDestroyed: () => false };
  __testing.resetTokens();
  for (let i = 0; i < __testing.MAX_TOKENS_PER_SENDER - 1; i++) {
    issueUserAttachmentToken({
      sender,
      path: `/tmp/existing-${i}.png`,
      name: `existing-${i}.png`,
      mediaType: 'image/png',
    });
  }

  await assert.rejects(
    selectUserAttachments({ sender }, {
      mediaTypes: ['image/png'],
    }, {
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/new-a.png', '/tmp/new-b.png'] }),
      },
    }),
    /token limit reached/,
  );

  assert.equal(__testing.countTokensForSender(sender), __testing.MAX_TOKENS_PER_SENDER - 1);
  __testing.resetTokens();
});

test('rejects renderer-supplied raw paths and unauthorised attachment tokens', async () => {
  assert.throws(
    () => validateRequest({ path: '/tmp/pixel.png', mediaType: 'image/png', maxBytes: 1024 }),
    /unsupported request field path/i,
  );
  await assert.rejects(
    readUserAttachment({ sender: {} }, { token: 'missing-token' }, { fs: fakeFs(PNG), now: 1_000 }),
    /token/i,
  );
});

test('binds image attachment tokens to the issuing sender and expires them', async () => {
  const sender = {};
  const otherSender = {};
  const issued = issueUserAttachmentToken({
    sender,
    path: '/tmp/pixel.png',
    name: 'pixel.png',
    mediaType: 'image/png',
    now: 1_000,
    ttlMs: 10,
  });

  await assert.rejects(
    readUserAttachment({ sender: otherSender }, { token: issued.token }, { fs: fakeFs(PNG), now: 1_000 }),
    /different IPC sender/,
  );
  await assert.rejects(
    readUserAttachment({ sender }, { token: issued.token }, { fs: fakeFs(PNG), now: 1_011 }),
    /expired/,
  );
});

test('releases attachment tokens only for their issuing sender and is idempotent for that sender', async () => {
  const sender = {};
  const otherSender = {};
  __testing.resetTokens();
  const issued = issueUserAttachmentToken({
    sender,
    path: '/tmp/pixel.png',
    name: 'pixel.png',
    mediaType: 'image/png',
    now: 1_000,
  });

  assert.throws(
    () => releaseUserAttachment({ sender: otherSender }, { token: issued.token }),
    /different IPC sender/,
  );
  assert.equal(__testing.countTokensForSender(sender), 1);
  assert.deepEqual(releaseUserAttachment({ sender }, { token: issued.token }), { released: true });
  assert.deepEqual(releaseUserAttachment({ sender }, { token: issued.token }), { released: false });
  assert.equal(__testing.countTokensForSender(sender), 0);
  __testing.resetTokens();
});

test('rejects attachment bytes that do not match the declared media type', async () => {
  const sender = {};
  await assert.rejects(
    readUserAttachment({ sender }, {
      token: issueUserAttachmentToken({
        sender,
        path: '/tmp/pixel.png',
        name: 'pixel.png',
        mediaType: 'image/png',
        now: 1_000,
      }).token,
    }, { fs: fakeFs(Buffer.from('not a pdf', 'ascii')), now: 1_000 }),
    /bytes do not match/,
  );
});

test('selects a PNG through the main picker as an image token and reads it back', async () => {
  const sender = {};
  const selected = await selectUserAttachments({ sender }, {
    mediaTypes: ['image/png'],
  }, {
    dialog: {
      showOpenDialog: async (options) => {
        assert.deepEqual(options.properties, ['openFile', 'multiSelections']);
        assert.deepEqual(options.filters, [{ name: 'Images', extensions: ['png'] }]);
        return { canceled: false, filePaths: ['/tmp/pixel.png'] };
      },
    },
  });

  assert.equal(selected.length, 1);
  assert.match(selected[0].token, /^[A-Za-z0-9_-]{32,}$/);
  assert.deepEqual({
    name: selected[0].name,
    mediaType: selected[0].mediaType,
  }, {
    name: 'pixel.png',
    mediaType: 'image/png',
  });

  const bytes = await readUserAttachment({ sender }, { token: selected[0].token }, { fs: fakeFs(PNG) });
  assert.deepEqual(Buffer.from(bytes), PNG);
});

test('select defaults to image types and rejects PDF selections', async () => {
  const sender = {};
  const selected = await selectUserAttachments({ sender }, {}, {
    dialog: {
      showOpenDialog: async (options) => {
        assert.deepEqual(options.properties, ['openFile', 'multiSelections']);
        assert.deepEqual(options.filters, [{
          name: 'Images',
          extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
        }]);
        return { canceled: false, filePaths: ['/tmp/default.png'] };
      },
    },
  });
  assert.equal(selected[0].mediaType, 'image/png');

  await assert.rejects(
    selectUserAttachments({ sender }, {
      mediaTypes: ['application/pdf'],
    }, {
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/brief.pdf'] }),
      },
    }),
    /media type is unsupported/,
  );
});

test('raw authorize API is image-only and rejects PDF direct input', () => {
  const image = authorizeUserAttachment({ sender: {} }, {
    path: '/tmp/shot.png',
    name: 'shot.png',
    mediaType: 'image/png',
    now: 1_000,
  });
  assert.equal(image.mediaType, 'image/png');

  assert.throws(
    () => authorizeUserAttachment({ sender: {} }, {
      path: '/tmp/brief.pdf',
      name: 'brief.pdf',
      mediaType: 'application/pdf',
      now: 1_000,
    }),
    /media type is unsupported/,
  );
  assert.throws(
    () => validateRequest({ token: 'tok', source: 'renderer' }),
    /unsupported request field source/,
  );
});

test('rejects symlinks before reading bytes', async () => {
  const sender = {};
  let read = false;
  await assert.rejects(
    readUserAttachment({ sender }, { token: issueUserAttachmentToken({
      sender,
      path: '/tmp/link.png',
      name: 'link.png',
      mediaType: 'image/png',
      now: 1_000,
    }).token }, {
      fs: {
        constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
        open: async () => {
          const error = new Error('symlink');
          error.code = 'ELOOP';
          throw error;
        },
      },
      now: 1_000,
    }),
    /symlink is not allowed/,
  );
  assert.equal(read, false);
});

test('rejects non-regular and oversized files before reading bytes', async () => {
  for (const stats of [
    { isFile: () => false, size: PNG.byteLength },
    { isFile: () => true, size: 1025 },
  ]) {
    let read = false;
    const sender = {};
    await assert.rejects(
      readUserAttachment({ sender }, { token: issueUserAttachmentToken({
        sender,
        path: '/tmp/pixel.png',
        name: 'pixel.png',
        mediaType: 'image/png',
        now: 1_000,
        maxBytes: 1024,
      }).token }, {
        fs: {
          constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
          open: async () => ({
            stat: async () => stats,
            read: async () => {
              read = true;
              return { bytesRead: 0 };
            },
            close: async () => {},
          }),
        },
        now: 1_000,
      }),
      /file is invalid/,
    );
    assert.equal(read, false);
  }
});

test('rejects size races after read', async () => {
  const sender = {};
  await assert.rejects(
    readUserAttachment({ sender }, { token: issueUserAttachmentToken({
      sender,
      path: '/tmp/pixel.png',
      name: 'pixel.png',
      mediaType: 'image/png',
      now: 1_000,
      maxBytes: 1024,
    }).token }, {
      fs: {
        constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
        open: async () => ({
          stat: async () => ({ isFile: () => true, size: PNG.byteLength + 1 }),
          read: async (buffer, offset, length, position) => {
            PNG.copy(buffer, offset, position, position + length);
            return { bytesRead: Math.min(length, PNG.byteLength - position) };
          },
          close: async () => {},
        }),
      },
      now: 1_000,
    }),
    /file size changed/,
  );
});

test('reads through one opened fd so a path replacement race cannot swap bytes', async () => {
  const sender = {};
  const openedBytes = Buffer.from(PNG);
  const maliciousReplacement = Buffer.from('not a png anymore', 'ascii');
  let fdClosed = false;
  const fsImpl = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
    open: async () => ({
      stat: async () => ({ isFile: () => true, size: openedBytes.byteLength }),
      read: async (buffer, offset, length, position) => {
        maliciousReplacement.copy(maliciousReplacement, 0, 0, maliciousReplacement.length);
        openedBytes.copy(buffer, offset, position, position + length);
        return { bytesRead: Math.min(length, openedBytes.byteLength - position) };
      },
      close: async () => { fdClosed = true; },
    }),
  };
  const issued = issueUserAttachmentToken({
    sender,
    path: '/tmp/pixel.png',
    name: 'pixel.png',
    mediaType: 'image/png',
    now: 1_000,
  });

  const bytes = await readUserAttachment({ sender }, { token: issued.token }, { fs: fsImpl, now: 1_000 });

  assert.deepEqual(Buffer.from(bytes), openedBytes);
  assert.equal(fdClosed, true);
});
