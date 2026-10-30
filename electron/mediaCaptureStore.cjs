'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { createNativeFileSession } = require('./nativeHelperManager.cjs');
const { assertAllowed } = require('./fsHost.cjs');
const { imageEditAttachmentSchema } = require('./generated/mediaRuntime.cjs');

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
const MAX_CONVERSATION_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;

function captureBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Image capture directory contains a symbolic link');
    if (entry.isDirectory()) total += captureBytes(file);
    else if (entry.name.endsWith('.png')) total += fs.statSync(file).size;
  }
  return total;
}

async function readControlledImage(filePath, allowedRoot) {
  assertAllowed(filePath, { followFinalSymlink: true });
  const target = { path: filePath, purpose: 'read', followFinalSymlink: true };
  const native = createNativeFileSession([target]);
  try {
    const observed = await native.request('observe', target);
    assertAllowed(observed.canonicalPath, { followFinalSymlink: true });
    if (allowedRoot) {
      const relative = path.relative(allowedRoot, observed.canonicalPath);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Image source left its conversation');
    }
    const info = await native.request('media-info', { reference: observed.reference });
    if (info.size <= 0 || info.size > MAX_SOURCE_BYTES) throw new Error('Image file exceeds the supported size');
    const parts = [];
    for (let offset = 0; offset < info.size; offset += 1024 * 1024) {
      const chunk = await native.request('read-media-range', {
        reference: observed.reference, offset, length: Math.min(1024 * 1024, info.size - offset),
        expectedSize: info.size, expectedModifiedNs: info.modifiedNs,
      });
      parts.push(Buffer.from(chunk.base64, 'base64'));
    }
    return Buffer.concat(parts);
  } finally {
    await native.release();
  }
}

function createMediaCaptureStore({ root, assertConversation, assertCapacity }) {
  if (fs.existsSync(root)) {
    if (fs.realpathSync(root) !== path.resolve(root)) throw new Error('Image capture directory changed');
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) throw new Error('Image capture directory is invalid');
    }
  }
  function directory(conversationId) {
    assertConversation(conversationId);
    return path.join(root, createHash('sha256').update(conversationId).digest('hex'));
  }

  function capturePath(conversationId, captureId, extension) {
    if (typeof captureId !== 'string' || !/^[a-f0-9-]{36}$/.test(captureId)) throw new Error('Image capture is unavailable');
    return path.join(directory(conversationId), `${captureId}.${extension}`);
  }

  function ownedCapture(conversationId, reference) {
    const folder = directory(conversationId);
    if (fs.realpathSync(folder) !== path.resolve(folder)) throw new Error('Image capture directory changed');
    const file = capturePath(conversationId, reference.captureId, 'json');
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let attachment;
    try { attachment = imageEditAttachmentSchema.parse(JSON.parse(fs.readFileSync(descriptor, 'utf8'))); }
    finally { fs.closeSync(descriptor); }
    if (attachment.fileRef.captureId !== reference.captureId || attachment.fileRef.originalPath !== reference.originalPath || attachment.fileRef.contentDigest !== reference.contentDigest) {
      throw new Error('Image capture does not match the requested source');
    }
    return { attachment, path: capturePath(conversationId, reference.captureId, 'png'), mimeType: 'image/png', contentDigest: reference.contentDigest };
  }

  return {
    reconcile(records) {
      const retained = new Set();
      for (const { request } of records) {
        for (const attachment of request.attachmentRefs) {
          ownedCapture(request.conversationId, attachment.fileRef);
          const marker = capturePath(request.conversationId, attachment.fileRef.captureId, 'keep');
          retained.add(marker);
          if (!fs.existsSync(marker)) fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
        }
      }
      if (!fs.existsSync(root)) return;
      for (const folder of fs.readdirSync(root)) {
        for (const name of fs.readdirSync(path.join(root, folder))) {
          if (!/^[a-f0-9-]{36}\.(png|json|keep)$/.test(name)) throw new Error('Image capture file is invalid');
          const captureId = name.slice(0, name.lastIndexOf('.'));
          if (retained.has(path.join(root, folder, `${captureId}.keep`))) continue;
          fs.rmSync(path.join(root, folder, name));
        }
      }
    },

    unretain(conversationId, reference) {
      ownedCapture(conversationId, reference);
      fs.rmSync(capturePath(conversationId, reference.captureId, 'keep'), { force: true });
    },

    async capture(conversationId, file) {
      const input = await readControlledImage(file.path, file.allowedRoot);
      if (file.contentDigest && createHash('sha256').update(input).digest('hex') !== file.contentDigest) throw new Error('Image result content changed');
      const decoder = sharp(input, { limitInputPixels: MAX_SOURCE_PIXELS });
      const metadata = await decoder.metadata();
      if (metadata.pages > 1 || metadata.format === 'svg') throw new Error('This image format is unavailable for editing');
      const { data, info } = await decoder.autoOrient().png().toBuffer({ resolveWithObject: true });
      assertConversation(conversationId);
      return this.store(conversationId, file.originalPath ?? file.path, 'source', data, info.width, info.height);
    },

    store(conversationId, originalPath, kind, data, width, height) {
      assertConversation(conversationId);
      if (data.length > MAX_SOURCE_BYTES) throw new Error('The prepared image exceeds the supported size');
      assertCapacity?.(conversationId, data.length);
      const folder = directory(conversationId);
      if (captureBytes(folder) + data.length > MAX_CONVERSATION_BYTES || captureBytes(root) + data.length > MAX_TOTAL_BYTES) {
        throw new Error('Image storage capacity has been reached');
      }
      const captureId = randomUUID();
      const contentDigest = createHash('sha256').update(data).digest('hex');
      const attachment = {
        kind, fileRef: { originalPath, captureId, contentDigest },
        mimeType: 'image/png', width, height, byteLength: data.length,
      };
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(folder) !== path.resolve(folder)) throw new Error('Image capture directory changed');
      let stored = false;
      try {
        fs.writeFileSync(capturePath(conversationId, captureId, 'png'), data, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(capturePath(conversationId, captureId, 'json'), JSON.stringify(attachment), { flag: 'wx', mode: 0o600 });
        stored = true;
      } finally {
        if (!stored) {
          fs.rmSync(capturePath(conversationId, captureId, 'png'), { force: true });
          fs.rmSync(capturePath(conversationId, captureId, 'json'), { force: true });
        }
      }
      return attachment;
    },

    get(conversationId, reference) {
      assertAllowed(reference.originalPath, { followFinalSymlink: false });
      return ownedCapture(conversationId, reference);
    },

    async read(conversationId, reference) {
      const capture = this.get(conversationId, reference);
      const bytes = await readControlledImage(capture.path);
      if (createHash('sha256').update(bytes).digest('hex') !== reference.contentDigest) throw new Error('Image capture content changed');
      assertConversation(conversationId);
      return { ...capture, bytes };
    },

    retain(conversationId, reference) {
      ownedCapture(conversationId, reference);
      const marker = capturePath(conversationId, reference.captureId, 'keep');
      if (fs.existsSync(marker)) {
        if (!fs.lstatSync(marker).isFile()) throw new Error('Image capture retention record changed');
        return;
      }
      fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
    },

    release(conversationId, reference) {
      if (!fs.existsSync(capturePath(conversationId, reference.captureId, 'json'))) return;
      ownedCapture(conversationId, reference);
      if (fs.existsSync(capturePath(conversationId, reference.captureId, 'keep'))) return;
      fs.rmSync(capturePath(conversationId, reference.captureId, 'png'), { force: true });
      fs.rmSync(capturePath(conversationId, reference.captureId, 'json'), { force: true });
    },

    forget(conversationId) {
      fs.rmSync(path.join(root, createHash('sha256').update(conversationId).digest('hex')), { recursive: true, force: true });
    },
  };
}

module.exports = { createMediaCaptureStore, readControlledImage, MAX_SOURCE_BYTES, MAX_SOURCE_PIXELS };
