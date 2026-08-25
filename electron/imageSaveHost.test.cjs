'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_IMAGE_BYTES,
  safeSuggestedName,
  saveImageAttachment,
  writeImageAtomically,
} = require('./imageSaveHost.cjs');

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const GIF = Buffer.from('GIF89aDATA', 'ascii');
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0x01]);

function createDependencies({ canceled = false, filePath = '/chosen/export.png' } = {}) {
  const writes = [];
  const dialogs = [];
  const dependencies = {
    writeAtomic: (target, bytes) => writes.push({ target, bytes: Buffer.from(bytes) }),
    dialog: {
      showSaveDialog: async (...args) => {
        dialogs.push(args);
        return { canceled, filePath: canceled ? undefined : filePath };
      },
    },
    BrowserWindow: {
      fromWebContents: () => ({ isDestroyed: () => false }),
    },
  };
  return { dependencies, writes, dialogs };
}

const app = { getPath: () => '/downloads' };
const event = { sender: {} };

test('saves validated inline bytes to the user-selected path', async () => {
  const { dependencies, writes, dialogs } = createDependencies();

  const result = await saveImageAttachment(app, event, {
    data: PNG,
    mediaType: 'image/png',
    suggestedName: '../Abu image.jpeg',
  }, dependencies);

  assert.deepEqual(result, { saved: true, fileName: 'export.png' });
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0][1].defaultPath, '/downloads/Abu image.png');
  assert.deepEqual(dialogs[0][1].filters, [{ name: 'PNG image', extensions: ['png'] }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, '/chosen/export.png');
  assert.deepEqual(writes[0].bytes, Buffer.from(PNG));
});

test('does not write when the native save dialog is cancelled', async () => {
  const { dependencies, writes } = createDependencies({ canceled: true });

  const result = await saveImageAttachment(app, event, {
    data: PNG,
    mediaType: 'image/png',
  }, dependencies);

  assert.deepEqual(result, { saved: false });
  assert.equal(writes.length, 0);
});

test('rejects mismatched formats, missing bytes, and path sources', async () => {
  const { dependencies } = createDependencies();

  await assert.rejects(
    saveImageAttachment(app, event, { data: GIF, mediaType: 'image/png' }, dependencies),
    /bytes do not match/,
  );
  await assert.rejects(
    saveImageAttachment(app, event, {
      sourcePath: '/also/source.png',
      mediaType: 'image/png',
    }, dependencies),
    /unsupported request field sourcePath/,
  );
  await assert.rejects(
    saveImageAttachment(app, event, { mediaType: 'image/png' }, dependencies),
    /data must be binary/,
  );
  await assert.rejects(
    saveImageAttachment(app, event, {
      data: PNG,
      mediaType: 'image/png',
      destinationPath: '/renderer-chosen/path.png',
    }, dependencies),
    /unsupported request field destinationPath/,
  );
});

test('rejects oversized inline images before opening a dialog', async () => {
  const { dependencies, dialogs } = createDependencies();

  await assert.rejects(
    saveImageAttachment(app, event, {
      data: Buffer.allocUnsafe(MAX_IMAGE_BYTES + 1),
      mediaType: 'image/gif',
    }, dependencies),
    /image size is invalid/,
  );
  assert.equal(dialogs.length, 0);
});

test('rejects destination extensions outside the declared image format', async () => {
  for (const filePath of ['/chosen/export.html', '/chosen/export']) {
    const { dependencies, writes } = createDependencies({ filePath });
    await assert.rejects(
      saveImageAttachment(app, event, { data: GIF, mediaType: 'image/gif' }, dependencies),
      /destination extension does not match/,
    );
    assert.equal(writes.length, 0);
  }

  const { dependencies, writes } = createDependencies({ filePath: '/chosen/export.jpeg' });
  await saveImageAttachment(app, event, { data: JPEG, mediaType: 'image/jpeg' }, dependencies);
  assert.equal(writes.length, 1);
});

test('allows only one pending save per IPC sender', async () => {
  let resolveDialog;
  const { dependencies } = createDependencies();
  dependencies.dialog.showSaveDialog = () => new Promise((resolve) => {
    resolveDialog = resolve;
  });

  const first = saveImageAttachment(app, event, { data: PNG, mediaType: 'image/png' }, dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    saveImageAttachment(app, event, { data: PNG, mediaType: 'image/png' }, dependencies),
    /another save is already in progress/,
  );
  resolveDialog({ canceled: true });
  await assert.doesNotReject(first);

  dependencies.dialog.showSaveDialog = async () => ({ canceled: true });
  await assert.doesNotReject(
    saveImageAttachment(app, event, { data: PNG, mediaType: 'image/png' }, dependencies),
  );
});

test('atomic save replaces a selected hard link without modifying its other name', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-image-save-hardlink-'));
  try {
    const victim = path.join(directory, 'victim.png');
    const selected = path.join(directory, 'selected.png');
    fs.writeFileSync(victim, 'original');
    fs.linkSync(victim, selected);
    const dependencies = {
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: selected }) },
      BrowserWindow: { fromWebContents: () => null },
    };

    await saveImageAttachment(app, event, { data: PNG, mediaType: 'image/png' }, dependencies);

    assert.equal(fs.readFileSync(victim, 'utf8'), 'original');
    assert.deepEqual(fs.readFileSync(selected), Buffer.from(PNG));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('atomic save replaces a selected symlink instead of following it', {
  skip: process.platform === 'win32' ? 'symlink creation needs elevated Windows privileges' : false,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-image-save-symlink-'));
  try {
    const victim = path.join(directory, 'victim.png');
    const selected = path.join(directory, 'selected.png');
    fs.writeFileSync(victim, 'original');
    fs.symlinkSync(victim, selected);
    const dependencies = {
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: selected }) },
      BrowserWindow: { fromWebContents: () => null },
    };

    await saveImageAttachment(app, event, { data: PNG, mediaType: 'image/png' }, dependencies);

    assert.equal(fs.readFileSync(victim, 'utf8'), 'original');
    assert.equal(fs.lstatSync(selected).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(selected), Buffer.from(PNG));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('atomic save accepts a legal destination basename near the component limit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-image-save-long-name-'));
  try {
    const selected = path.join(directory, `${'a'.repeat(210)}.png`);
    const dependencies = {
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: selected }) },
      BrowserWindow: { fromWebContents: () => null },
    };

    const result = await saveImageAttachment(
      app,
      event,
      { data: PNG, mediaType: 'image/png' },
      dependencies,
    );

    assert.deepEqual(result, { saved: true, fileName: path.basename(selected) });
    assert.deepEqual(fs.readFileSync(selected), Buffer.from(PNG));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('atomic write failure leaves an existing destination intact', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-image-save-failure-'));
  try {
    const destination = path.join(directory, 'selected.png');
    fs.writeFileSync(destination, 'original');
    let firstWrite = true;
    const failingFs = {
      constants: fs.constants,
      realpathSync: fs.realpathSync,
      openSync: fs.openSync,
      closeSync: fs.closeSync,
      fsyncSync: fs.fsyncSync,
      renameSync: fs.renameSync,
      rmSync: fs.rmSync,
      writeSync(fd, bytes, offset, length) {
        if (firstWrite) {
          firstWrite = false;
          fs.writeSync(fd, bytes, offset, Math.min(4, length));
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return fs.writeSync(fd, bytes, offset, length);
      },
    };

    assert.throws(
      () => writeImageAtomically(destination, Buffer.from(PNG), failingFs),
      /disk full/,
    );
    assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(directory), ['selected.png']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('normalizes unsafe or mismatched suggested extensions', () => {
  assert.equal(safeSuggestedName('../../bad:*name.jpg', 'webp'), 'bad--name.webp');
  assert.equal(safeSuggestedName('', 'png'), 'Abu-image.png');
});
