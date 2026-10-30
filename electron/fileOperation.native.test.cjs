'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const helper = require('./nativeHelperManager.cjs');
const { PNG } = require('pngjs');
let sessionSequence = 0;

// This suite talks to the real built helper and real files. It belongs to the
// native acceptance gate, after the official native-helper build.
test.after(() => helper.killNativeHelper('file-operation-tests-finished'));

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.agent');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'file-operation-native-'));
  const releases = [];
  t.after(async () => {
    const failures = [];
    try {
      const released = await Promise.allSettled(releases.map(release => release()));
      for (const result of released) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    } finally {
      const resolvedRoot = path.resolve(root);
      const relative = path.relative(parent, resolvedRoot);
      assert.ok(path.isAbsolute(resolvedRoot) && relative !== ''
        && relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative), 'Fixture cleanup must stay strictly inside the repository .agent directory');
      try { await fs.rm(resolvedRoot, { recursive: true, force: true }); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Native file fixture cleanup failed');
  });
  async function open(targets) {
    const session = String(++sessionSequence);
    await helper.callHelper('file_operation', { action: 'open', session, targets });
    releases.push(() => helper.callHelper('file_operation', { action: 'release', session }));
    return (action, request = {}) => helper.callHelper('file_operation', { action, session, ...request });
  }
  const trackNative = session => { releases.push(() => session.release()); return session; };
  return { root, open, trackNative };
}

function target(file, purpose = 'read', followFinalSymlink = true) {
  return { path: file, inputPath: file, purpose, followFinalSymlink };
}

test('media ranges read only requested bytes from a file above the whole-file limit', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'large-video.bin');
  const handle = await fs.open(file, 'wx');
  const size = 201 * 1024 * 1024;
  try {
    await handle.truncate(size);
    await handle.write(Buffer.from('ending'), 0, 6, size - 6);
  } finally {
    await handle.close();
  }
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  const info = await call('media-info', { reference: observed.reference });
  assert.equal(info.size, size);
  const request = { reference: observed.reference, expectedSize: info.size, expectedModifiedNs: info.modifiedNs };
  const tail = await call('read-media-range', { ...request, offset: size - 6, length: 6 });
  assert.equal(Buffer.from(tail.base64, 'base64').toString(), 'ending');
  await assert.rejects(call('read-media-range', { ...request, offset: 0, length: 1024 * 1024 + 1 }));
  await assert.rejects(call('read-media-range', { ...request, offset: size - 1, length: 2 }));
  await assert.rejects(call('read-media-range', { ...request, offset: -1, length: 1 }));
  await fs.writeFile(file, 'changed');
  await assert.rejects(call('read-media-range', { ...request, offset: 0, length: 1 }));
  await call('release');
  await assert.rejects(call('media-info', { reference: observed.reference }));
});

async function imageFixture(t, outputPurpose = 'write') {
  const setup = await fixture(t);
  const input = path.join(setup.root, 'input.png');
  const output = path.join(setup.root, 'output.png');
  const png = new PNG({ width: 4, height: 4 });
  for (let pixel = 0; pixel < 16; pixel += 1) {
    png.data.set([pixel * 8, 64, 128, 128], pixel * 4);
  }
  const original = PNG.sync.write(png);
  await fs.writeFile(input, original);
  await fs.writeFile(output, 'original output');
  const call = await setup.open([target(input), target(output, outputPurpose)]);
  const read = await call('observe', target(input));
  const write = await call('observe', target(output, outputPurpose));
  const processImage = options => call('image-process', {
    reference: read.reference, outputReference: write.reference, ...options,
  });
  return { ...setup, input, output, original, call, read, write, processImage };
}

test('image processing resizes retained input into the approved output and preserves alpha', async t => {
  const { input, output, original, processImage } = await imageFixture(t);
  await processImage({ operation: 'resize', params: { width: 2, height: 3 } });
  const result = PNG.sync.read(await fs.readFile(output));
  assert.equal(result.width, 2);
  assert.equal(result.height, 3);
  assert.equal(result.data[3], 128);
  assert.deepEqual(await fs.readFile(input), original);
});

test('image processing crops at the requested offset, and at the origin without one', async t => {
  const { output, processImage } = await imageFixture(t);
  // Pixel n of the 4x4 fixture has red n * 8; a centered 2x2 crop would start at (1, 1), red 40.
  await processImage({ operation: 'crop', params: { width: 2, height: 2, x: 2, y: 1 } });
  const offset = PNG.sync.read(await fs.readFile(output));
  assert.equal(offset.width, 2);
  assert.equal(offset.height, 2);
  assert.deepEqual([...offset.data.subarray(0, 4)], [48, 64, 128, 128]);
  await processImage({ operation: 'crop', params: { width: 2, height: 2 } });
  const origin = PNG.sync.read(await fs.readFile(output));
  assert.deepEqual([...origin.data.subarray(0, 4)], [0, 64, 128, 128]);
});

test('image processing supports declared conversion formats and JPEG quality', async t => {
  const { output, processImage } = await imageFixture(t);
  for (const [format, signature] of [
    ['png', [137, 80, 78, 71]], ['jpeg', [255, 216]], ['gif', [71, 73, 70]],
    ['bmp', [66, 77]], ['tiff', [73, 73, 42, 0]],
  ]) {
    await processImage({ operation: 'convert', params: { format } });
    const bytes = await fs.readFile(output);
    assert.deepEqual([...bytes.subarray(0, signature.length)], signature);
  }
  await processImage({ operation: 'compress', params: { quality: 65 } });
  assert.deepEqual([...(await fs.readFile(output)).subarray(0, 2)], [255, 216]);
});

test('image processing completes encoding before changing a target and refuses excessive dimensions', async t => {
  const { input, output, processImage } = await imageFixture(t);
  await processImage({ operation: 'resize', params: { width: 2, height: 2 } });
  const retained = await fs.readFile(output);
  await assert.rejects(processImage({ operation: 'resize', params: { width: 0xffffffff, height: 0xffffffff } }));
  assert.deepEqual(await fs.readFile(output), retained);
  await assert.rejects(processImage({ operation: 'resize', params: { width: 16_384, height: 16_384 } }));
  assert.deepEqual(await fs.readFile(output), retained);
  await assert.rejects(processImage({ operation: 'crop', params: { width: 2, height: 2, x: Number.MAX_SAFE_INTEGER } }));
  assert.deepEqual(await fs.readFile(output), retained);
  await fs.writeFile(input, 'invalid image bytes');
  await assert.rejects(processImage({ operation: 'resize', params: { width: 2, height: 2 } }));
  assert.deepEqual(await fs.readFile(output), retained);
});

test('image processing returns resized read bytes and rejects output permission upgrades', async t => {
  const { output, call, read, write } = await imageFixture(t, 'read');
  const result = await call('image-process', { reference: read.reference, operation: 'fit-width', params: { width: 2 } });
  const png = PNG.sync.read(Buffer.from(result.bytes));
  assert.equal(png.width, 2);
  assert.equal(png.height, 2);
  await assert.rejects(call('image-process', { reference: read.reference, outputReference: write.reference,
    operation: 'resize', params: { width: 2, height: 2 } }));
  assert.equal(await fs.readFile(output, 'utf8'), 'original output');
});

test('image processing refuses a released original session and preserves the output', async t => {
  const { output, call, processImage } = await imageFixture(t);
  await processImage({ operation: 'resize', params: { width: 2, height: 2 } });
  const retained = await fs.readFile(output);
  await call('release');
  await assert.rejects(processImage({ operation: 'resize', params: { width: 3, height: 3 } }));
  assert.deepEqual(await fs.readFile(output), retained);
});

test('scoped Office query discloses only its approved retained target', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'office-target.xlsx');
  await fs.writeFile(file, 'query fixture');
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  const report = await call('office-document', { reference: observed.reference });
  if (process.platform !== 'win32') {
    // Office open-document reporting is a Windows capability; elsewhere the helper says so and discloses nothing.
    assert.deepEqual(report, { supported: false, complete: false, documents: [] });
    return;
  }
  assert.equal(report.supported, true);
  assert.equal(typeof report.complete, 'boolean');
  assert.ok(Array.isArray(report.documents));
  assert.ok(report.documents.every(document => path.resolve(document.path) === file
    && document.name === path.basename(file) && document.samePath), 'Only the retained target may be returned');
});

test('reads an observed file and refuses to upgrade a read reference to write', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, '报告.txt');
  await fs.writeFile(file, 'native file content');
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  assert.equal(observed.exists, true);
  assert.equal(observed.isFile, true);
  const result = await call('read', { reference: observed.reference });
  assert.equal(Buffer.from(result.bytes).toString('utf8'), 'native file content');
  await assert.rejects(call('write', { reference: observed.reference, bytes: [0] }));
  assert.equal(await fs.readFile(file, 'utf8'), 'native file content');
});

test('binds references and immutable targets to one native session', async t => {
  const { root, open } = await fixture(t);
  const first = path.join(root, 'first.txt');
  const other = path.join(root, 'other.txt');
  await fs.writeFile(first, 'first');
  await fs.writeFile(other, 'other');
  const call = await open([target(first)]);
  const second = await open([target(first)]);
  const observed = await call('observe', target(first));
  await second('observe', target(first));
  await assert.rejects(second('read', { reference: observed.reference }));
  await assert.rejects(call('observe', target(other)));
  await assert.rejects(call('observe', target(first, 'write')));
});

test('observing a future output neither creates nor truncates files', async t => {
  const { root, open } = await fixture(t);
  const future = path.join(root, 'new', 'nested', 'output.txt');
  const existing = path.join(root, 'existing.txt');
  await fs.writeFile(existing, 'retain until write');
  const call = await open([target(future, 'write'), target(existing, 'write')]);
  const next = await call('observe', target(future, 'write'));
  await call('observe', target(existing, 'write'));
  assert.equal(next.exists, false);
  await assert.rejects(fs.access(path.dirname(future)));
  assert.equal(await fs.readFile(existing, 'utf8'), 'retain until write');
  await call('ensure-parent', { reference: next.reference });
  await call('write', { reference: next.reference, bytes: [...Buffer.from('created safely')] });
  assert.equal(await fs.readFile(future, 'utf8'), 'created safely');
});

test('refuses an observed entry replaced while execution is waiting', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'entry.txt');
  await fs.writeFile(file, 'original');
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  try {
    await fs.rename(file, path.join(root, 'old-entry.txt'));
  } catch (error) {
    // A retained Windows handle may deny replacement at the OS boundary.
    assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    const result = await call('read', { reference: observed.reference });
    assert.equal(Buffer.from(result.bytes).toString('utf8'), 'original');
    return;
  }
  await fs.writeFile(file, 'replacement');
  await assert.rejects(call('read', { reference: observed.reference }));
});

test('refuses an observed parent replaced while execution is waiting', async t => {
  const { root, open } = await fixture(t);
  const parent = path.join(root, 'parent');
  const file = path.join(parent, 'entry.txt');
  await fs.mkdir(parent);
  await fs.writeFile(file, 'original');
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  try {
    await fs.rename(parent, path.join(root, 'old-parent'));
  } catch (error) {
    assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    return;
  }
  await fs.mkdir(parent);
  await fs.writeFile(file, 'replacement');
  await assert.rejects(call('read', { reference: observed.reference }));
});

test('enumerates an explicitly followed directory link and refuses link deletion traversal', async t => {
  const { root, open } = await fixture(t);
  const directory = path.join(root, 'real');
  const alias = path.join(root, 'alias');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'report.txt'), 'linked report');
  await fs.symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const call = await open([target(alias, 'traverse'), target(alias, 'delete', false)]);
  const followed = await call('observe', target(alias, 'traverse'));
  const page = await call('enumerate', { reference: followed.reference, cursor: null });
  assert.deepEqual(page.entries.map(entry => entry.name), ['report.txt']);
  const child = await call('observe-child', { parent: followed.reference, entry: page.entries[0].reference, purpose: 'read', followFinalSymlink: true });
  assert.equal(Buffer.from((await call('read', { reference: child.reference })).bytes).toString(), 'linked report');
  const link = await call('observe', target(alias, 'delete', false));
  await assert.rejects(call('enumerate', { reference: link.reference, cursor: null }));
});

test('enumeration includes hidden names and child references require their own parent', async t => {
  const { root, open } = await fixture(t);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.writeFile(path.join(first, '.hidden'), 'hidden');
  await fs.writeFile(path.join(first, 'visible.txt'), 'visible');
  const call = await open([target(first, 'list'), target(second, 'list')]);
  const parent = await call('observe', target(first, 'list'));
  const other = await call('observe', target(second, 'list'));
  const page = await call('enumerate', { reference: parent.reference, cursor: null });
  assert.equal(page.complete, true);
  assert.equal(page.cursor, null);
  assert.deepEqual(page.entries.map(entry => entry.name).sort(), ['.hidden', 'visible.txt']);
  const entry = page.entries.find(item => item.name === 'visible.txt');
  await assert.rejects(call('observe-child', { parent: other.reference, entry: entry.reference, purpose: 'read', followFinalSymlink: true }));
  const child = await call('observe-child', { parent: parent.reference, entry: entry.reference, purpose: 'read', followFinalSymlink: true });
  const result = await call('read', { reference: child.reference });
  assert.equal(Buffer.from(result.bytes).toString('utf8'), 'visible');
});

test('Trash preflight returns the directory link entry and releases it without touching its target', async t => {
  const { root, open } = await fixture(t);
  const directory = path.join(root, 'real-trash-target');
  const alias = path.join(root, 'trash-link');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'report.txt'), 'target content');
  await fs.symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const call = await open([target(alias, 'delete', false)]);
  const link = await call('observe', target(alias, 'delete', false));
  const entry = await call('trash', { reference: link.reference, manifest: [link.reference] });
  assert.equal(path.resolve(entry.path), alias);
  assert.equal(await fs.readFile(path.join(directory, 'report.txt'), 'utf8'), 'target content');
  await fs.rename(alias, path.join(root, 'released-link'));
});

test('released sessions reject further I/O and release is idempotent', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'entry.txt');
  await fs.writeFile(file, 'original');
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  await call('release');
  await call('release');
  await assert.rejects(call('read', { reference: observed.reference }));
  await assert.rejects(call('observe', target(file)));
});

test('cancelling an open still queued in the host does not start a helper', async t => {
  const { root, trackNative } = await fixture(t);
  helper.killNativeHelper('file-open-cancellation-fixture');
  const generation = helper.getNativeHelperGeneration();
  const file = path.join(root, 'queued.txt');
  const session = trackNative(helper.createNativeFileSession([target(file, 'write')]));
  await session.release();
  assert.equal(helper.getNativeHelperGeneration(), generation);
  await assert.rejects(session.request('observe', target(file, 'write')));
  await assert.rejects(fs.access(file));
});

test('a late release cannot affect a file session on a replacement helper', async t => {
  const { root, trackNative } = await fixture(t);
  const file = path.join(root, 'retained.txt');
  await fs.writeFile(file, 'retained');
  const old = trackNative(helper.createNativeFileSession([target(file)]));
  const previous = await old.request('observe', target(file));
  helper.killNativeHelper('file-generation-fixture');
  const current = trackNative(helper.createNativeFileSession([target(file)]));
  const observed = await current.request('observe', target(file));
  await old.release();
  await assert.rejects(old.request('read', { reference: previous.reference }));
  const result = await current.request('read', { reference: observed.reference });
  assert.equal(Buffer.from(result.bytes).toString('utf8'), 'retained');
});

test('proves an existing Unicode entry distinct from an unrelated literal in its held parent', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, '报告.txt');
  await fs.writeFile(file, 'report');
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  const component = observed.comparison.lexical.components.length - 1;
  const result = await call('compare-component', {
    reference: observed.reference, pathKind: 'lexical', component, pattern: 'private.txt',
  });
  assert.equal(result, 'no-match');
});

test('distinguishes two hardlink names when querying one observed directory entry', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'report.txt');
  await fs.writeFile(file, 'shared inode');
  await fs.link(file, path.join(root, 'private.txt'));
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  const result = await call('compare-component', {
    reference: observed.reference, pathKind: 'lexical',
    component: observed.comparison.lexical.components.length - 1, pattern: 'private.txt',
  });
  assert.equal(result, 'no-match');
});

test('does not infer future filename equivalence from a missing directory lookup', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, '未创建.txt');
  const call = await open([target(file, 'write')]);
  const observed = await call('observe', target(file, 'write'));
  const result = await call('compare-component', {
    reference: observed.reference, pathKind: 'lexical',
    component: observed.comparison.lexical.components.length - 1, pattern: 'private.txt',
  });
  assert.equal(result, 'unknown');
  await assert.rejects(fs.access(file));
});

test('uses complete native wildcard queries to distinguish an unrelated existing Unicode entry', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, '报告.txt');
  await fs.writeFile(file, 'report');
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  const result = await call('compare-component', {
    reference: observed.reference, pathKind: 'lexical',
    component: observed.comparison.lexical.components.length - 1, pattern: '*private*',
  });
  assert.equal(result, process.platform === 'win32' ? 'no-match' : 'unknown');
  const bytes = await call('read', { reference: observed.reference });
  assert.equal(Buffer.from(bytes.bytes).toString('utf8'), 'report');
});

test('keeps wildcard queries independent and compares the exact hardlink entry name', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'report.txt');
  await fs.writeFile(file, 'shared inode');
  await fs.link(file, path.join(root, 'private.txt'));
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  for (const pattern of ['*private*', '*unrelated*', '*private*']) {
    const result = await call('compare-component', {
      reference: observed.reference, pathKind: 'lexical',
      component: observed.comparison.lexical.components.length - 1, pattern,
    });
    assert.equal(result, process.platform === 'win32' ? 'no-match' : 'unknown');
  }
});

test('a native wildcard query matches the exact existing entry in its held parent', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'report.txt');
  await fs.writeFile(file, 'report');
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  const result = await call('compare-component', {
    reference: observed.reference, pathKind: 'lexical',
    component: observed.comparison.lexical.components.length - 1, pattern: '*report*',
  });
  assert.equal(result, process.platform === 'win32' ? 'match' : 'unknown');
});

test('does not treat the native star-dot-star special case as a literal dot match', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'report');
  await fs.writeFile(file, 'no extension');
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  const result = await call('compare-component', {
    reference: observed.reference, pathKind: 'lexical',
    component: observed.comparison.lexical.components.length - 1, pattern: '*.*',
  });
  assert.notEqual(result, 'match');
});

test('searches Unicode content and line numbers through one observed read handle', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'search-content.txt');
  const content = 'header\n中文 needle 42\nordinary line\nneedle 7\n';
  await fs.writeFile(file, content);
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  const result = await call('search-lines', {
    reference: observed.reference, pattern: 'needle [0-9]+', maxResults: 10,
  });
  assert.deepEqual(result.matches, [
    { lineNumber: 2, line: '中文 needle 42' }, { lineNumber: 4, line: 'needle 7' },
  ]);
  assert.equal(result.bytesRead, Buffer.byteLength(content));
});

test('bounds content search results inside the native file session', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'search-limit.txt');
  await fs.writeFile(file, 'needle one\nneedle two\nneedle three\n');
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  const result = await call('search-lines', {
    reference: observed.reference, pattern: 'needle', maxResults: 2,
  });
  assert.deepEqual(result.matches, [
    { lineNumber: 1, line: 'needle one' }, { lineNumber: 2, line: 'needle two' },
  ]);
});

test('content search requires a read reference from the same native session', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'search-access.txt');
  await fs.writeFile(file, 'needle');
  const call = await open([target(file, 'write')]);
  const observed = await call('observe', target(file, 'write'));
  await assert.rejects(call('search-lines', {
    reference: observed.reference, pattern: 'needle', maxResults: 10,
  }));
  assert.equal(await fs.readFile(file, 'utf8'), 'needle');
});

test('content search refuses invalid or unbounded regular expressions', async t => {
  const { root, open } = await fixture(t);
  const file = path.join(root, 'search-pattern.txt');
  await fs.writeFile(file, 'needle');
  const call = await open([target(file)]);
  const observed = await call('observe', target(file));
  for (const pattern of ['[', 'a{10000000}', 'a'.repeat(4097)]) {
    await assert.rejects(call('search-lines', {
      reference: observed.reference, pattern, maxResults: 10,
    }));
  }
});

for (const [label, bytes] of [
  ['non-UTF-8 image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff])],
  ['NUL-bearing binary', Buffer.from('header\0needle')],
]) {
  test(`content search identifies ${label} as unsearchable without ending the file session`, async t => {
    const { root, open } = await fixture(t);
    const binary = path.join(root, 'binary.dat');
    const textFile = path.join(root, 'readme.txt');
    await fs.writeFile(binary, bytes);
    await fs.writeFile(textFile, 'ordinary needle');
    const call = await open([target(binary), target(textFile)]);
    const binaryRef = await call('observe', target(binary));
    const textRef = await call('observe', target(textFile));
    const skipped = await call('search-lines', { reference: binaryRef.reference, pattern: 'needle', maxResults: 10 });
    assert.equal(skipped.searchable, false);
    assert.deepEqual(skipped.matches, []);
    const found = await call('search-lines', { reference: textRef.reference, pattern: 'needle', maxResults: 10 });
    assert.deepEqual(found.matches, [{ lineNumber: 1, line: 'ordinary needle' }]);
  });
}
